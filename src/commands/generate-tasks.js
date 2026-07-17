import fs from 'fs-extra';
import path from 'path';
import { CLIError } from '../core/errors.js';
import { callLLM } from '../services/llm.js';
import logger from '../ui/logger.js';

/**
 * Formats a milestone object or JSON string into a structured key-value text.
 * 
 * @param {Object|string} milestone - The milestone object or JSON string.
 * @returns {string} The formatted text.
 */
function formatMilestone(milestone) {
  if (!milestone) return '';
  let data = milestone;
  if (typeof milestone === 'string') {
    try {
      data = JSON.parse(milestone);
    } catch {
      return milestone;
    }
  }
  
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return `PROJECT_ID: ${data.PROJECT_ID || ''}
MILESTONE_NAME: ${data.MILESTONE_NAME || ''}
MILESTONE_DESCRIPTION: ${data.MILESTONE_DESCRIPTION || ''}
MILESTONE_OWNER: ${data.MILESTONE_OWNER || ''}
MILESTONE_PRIORITY: ${data.MILESTONE_PRIORITY || ''}
MILESTONE_START: ${data.MILESTONE_START || ''}
MILESTONE_END: ${data.MILESTONE_END || ''}`;
  }
  return String(milestone);
}

/**
 * Executes the generate-tasks command.
 * 
 * @param {Object} [options={}] - Command options.
 * @param {string} [options.milestone] - Path to milestone file.
 * @param {string} [options.employees] - Path to employees JSON file.
 * @param {string} [options.output] - Path to output JSON file.
 * @param {string} [options.model] - Specific model override.
 * @returns {Promise<void>}
 */
export async function generateTasksCommand(options = {}) {
  logger.clearAndBanner();

  const cwd = process.cwd();

  // 1. Resolve milestone file path
  let milestonePath = options.milestone;
  if (!milestonePath) {
    const candidates = ['milestone.json', 'milestone.md', 'milestone.txt'];
    for (const c of candidates) {
      const p = path.join(cwd, c);
      if (await fs.pathExists(p)) {
        milestonePath = p;
        break;
      }
    }
  } else {
    milestonePath = path.resolve(cwd, milestonePath);
  }

  if (!milestonePath || !(await fs.pathExists(milestonePath))) {
    throw new CLIError(
      'Milestone file not found.\n' +
      'Please specify one using -m <path> or create a milestone.json, milestone.md, or milestone.txt file in this directory.'
    );
  }

  // 2. Resolve employees file path
  let employeesPath = options.employees;
  if (!employeesPath) {
    const p = path.join(cwd, 'employees.json');
    if (await fs.pathExists(p)) {
      employeesPath = p;
    }
  } else {
    employeesPath = path.resolve(cwd, employeesPath);
  }

  if (!employeesPath || !(await fs.pathExists(employeesPath))) {
    throw new CLIError(
      'Employees file not found.\n' +
      'Please specify one using -e <path> or create an employees.json file in this directory.'
    );
  }

  // 3. Resolve output path
  const outputPath = options.output ? path.resolve(cwd, options.output) : path.join(cwd, 'tasks.json');

  // 4. Read milestone and employees content
  logger.info(`Reading milestone from: ${path.basename(milestonePath)}`);
  let milestoneStr = '';
  try {
    const rawContent = await fs.readFile(milestonePath, 'utf8');
    milestoneStr = formatMilestone(rawContent);
  } catch (err) {
    throw new CLIError(`Failed to read milestone file: ${err.message}`);
  }

  logger.info(`Reading employees from: ${path.basename(employeesPath)}`);
  let employeesStr = '';
  let employeesData = null;
  try {
    employeesData = await fs.readJson(employeesPath);
    employeesStr = JSON.stringify(employeesData, null, 2);
  } catch (err) {
    throw new CLIError(`Failed to parse employees JSON: ${err.message}`);
  }

  // 5. Construct the prompt
  const now = new Date().toISOString();
  const prompt = `You are a Task Generation Agent. Given a single project milestone, you break it into concrete, actionable tasks.

## INPUTS
You receive one milestone to decompose:
${milestoneStr}

CURRENT_TIMESTAMP: ${now}

- AVAILABLE_EMPLOYEES (assign tasks ONLY to people from this list):
${employeesStr}

Each employee has: Employee_ID, Employee_Name, Email, Role, Department, Manager, Location.

## YOUR TASK
- Break this milestone into 3-8 concrete tasks. Each task is a single piece of work someone can pick up.
- Order tasks logically. Where one task must finish before another can start, record that with dependencies.
- Keep every task's dates inside the milestone window (between MILESTONE_START and MILESTONE_END).
- Assign each task to the most suitable person from AVAILABLE_EMPLOYEES, matching their Role and Department.
- Output the result strictly as a valid JSON object matching the schema below. Do not wrap in markdown or add explanations.

## OUTPUT SCHEMA
{
  "tasks": [
    {
      "task_id": "string (unique identifier like T1, T2, etc.)",
      "project_id": "string (matches the milestone's project ID if provided)",
      "task_name": "string (short descriptive name)",
      "description": "string (detailed description of what needs to be done)",
      "assigned_to": "string (Employee_ID from the list)",
      "dependencies": ["array of task_ids"],
      "priority": "string (low, medium, high)",
      "status": "string (pending)",
      "start_date": "string (YYYY-MM-DD)",
      "end_date": "string (YYYY-MM-DD)",
      "estimated_hours": number
    }
  ]
}
`;

  // 6. Call the LLM
  const modelName = options.model || '';
  const stopProgress = logger.progress('Generating tasks using LLM');

  let llmResponse;
  try {
    llmResponse = await callLLM(prompt, modelName);
  } finally {
    stopProgress();
  }

  // 7. Clean and parse JSON response
  let cleaned = llmResponse.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, '');
    cleaned = cleaned.replace(/\n?```$/, '');
    cleaned = cleaned.trim();
  }

  let tasksJson;
  try {
    tasksJson = JSON.parse(cleaned);
  } catch (err) {
    logger.error('Failed to parse JSON response from LLM.');
    logger.info('Raw LLM Response:');
    console.log(llmResponse);
    throw new CLIError(`JSON Parsing Error: ${err.message}`);
  }

  if (!tasksJson.tasks || !Array.isArray(tasksJson.tasks)) {
    throw new CLIError('LLM response JSON structure is invalid. Expected a "tasks" array at the root.');
  }

  // 8. Write to output file
  await fs.outputJson(outputPath, tasksJson, { spaces: 2 });

  // 9. Display summary
  logger.success(`Successfully generated and assigned ${tasksJson.tasks.length} tasks!`);
  logger.info(`Output saved to: ${path.relative(cwd, outputPath)}`);
  logger.blank();

  console.log(logger.chalk.cyan.bold('Generated Tasks Summary:'));
  for (const task of tasksJson.tasks) {
    const employee = Array.isArray(employeesData)
      ? employeesData.find(e => e.Employee_ID === task.assigned_to)
      : null;
    const assigneeName = employee ? employee.Employee_Name : task.assigned_to;
    console.log(`  - [${task.task_id}] ${task.task_name}`);
    console.log(`    Assignee: ${assigneeName} (${task.assigned_to})`);
    console.log(`    Schedule: ${task.start_date} to ${task.end_date} (${task.estimated_hours}h)`);
    if (task.dependencies && task.dependencies.length > 0) {
      console.log(`    Dependencies: ${task.dependencies.join(', ')}`);
    }
  }
}

export default generateTasksCommand;
