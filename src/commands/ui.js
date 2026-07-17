import http from 'http';
import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { callLLM } from '../services/llm.js';
import logger from '../ui/logger.js';
import { CLIError } from '../core/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/**
 * Starts the local HTTP server and launches the Web UI.
 * 
 * @param {Object} options - CLI options.
 * @param {number} options.port - Port to run the server on.
 */
export async function uiCommand(options = {}) {
  const port = parseInt(options.port, 10) || 3000;
  const cwd = process.cwd();
  const webDir = path.resolve(__dirname, '../ui/web');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // API: Load existing workspace milestone and employees files
    if (pathname === '/api/load-workspace' && req.method === 'GET') {
      const milestoneJsonPath = path.join(cwd, 'milestone.json');
      const milestoneMdPath = path.join(cwd, 'milestone.md');
      const milestoneTxtPath = path.join(cwd, 'milestone.txt');
      const employeesPath = path.join(cwd, 'employees.json');
      const tasksPath = path.join(cwd, 'tasks.json');

      let milestoneStr = '';
      let employeesData = [];
      let tasksData = [];

      // Read milestone
      if (await fs.pathExists(milestoneJsonPath)) {
        try {
          const js = await fs.readJson(milestoneJsonPath);
          milestoneStr = JSON.stringify(js, null, 2);
        } catch {}
      } else if (await fs.pathExists(milestoneMdPath)) {
        milestoneStr = await fs.readFile(milestoneMdPath, 'utf8');
      } else if (await fs.pathExists(milestoneTxtPath)) {
        milestoneStr = await fs.readFile(milestoneTxtPath, 'utf8');
      }

      // Read employees
      if (await fs.pathExists(employeesPath)) {
        try {
          employeesData = await fs.readJson(employeesPath);
        } catch {}
      }

      // Read tasks
      if (await fs.pathExists(tasksPath)) {
        try {
          const tasksJson = await fs.readJson(tasksPath);
          tasksData = tasksJson.tasks || [];
        } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ milestone: milestoneStr, employees: employeesData, tasks: tasksData }));
      return;
    }

    // API: Generate tasks using LLM
    if (pathname === '/api/generate' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { milestone, employees, provider, apiKey, model } = data;

          if (!milestone) throw new Error('Milestone content is required.');
          if (!employees || !employees.length) throw new Error('Employees list is required.');
          if (!apiKey) throw new Error('API key is required.');

          // Set temp environment key for LLM call
          if (provider === 'gemini') {
            process.env.GEMINI_API_KEY = apiKey;
            delete process.env.OPENAI_API_KEY;
            delete process.env.ANTHROPIC_API_KEY;
          } else if (provider === 'openai') {
            process.env.OPENAI_API_KEY = apiKey;
            delete process.env.GEMINI_API_KEY;
            delete process.env.ANTHROPIC_API_KEY;
          } else if (provider === 'anthropic') {
            process.env.ANTHROPIC_API_KEY = apiKey;
            delete process.env.GEMINI_API_KEY;
            delete process.env.OPENAI_API_KEY;
          }

          const milestoneStrFormatted = formatMilestone(milestone);

          // Build prompt
          const now = new Date().toISOString();
          const prompt = `You are a Task Generation Agent. Given a single project milestone, you break it into concrete, actionable tasks.

## INPUTS
You receive one milestone to decompose:
${milestoneStrFormatted}

CURRENT_TIMESTAMP: ${now}

- AVAILABLE_EMPLOYEES (assign tasks ONLY to people from this list):
${JSON.stringify(employees, null, 2)}

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

          const responseText = await callLLM(prompt, model);

          // Clean response
          let cleaned = responseText.trim();
          if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\n?/i, '');
            cleaned = cleaned.replace(/\n?```$/, '');
            cleaned = cleaned.trim();
          }

          const parsed = JSON.parse(cleaned);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parsed));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        } finally {
          // Immediately wipe secret keys from environment to prevent leakage
          delete process.env.GEMINI_API_KEY;
          delete process.env.OPENAI_API_KEY;
          delete process.env.ANTHROPIC_API_KEY;
        }
      });
      return;
    }

    // API: Save tasks back to tasks.json
    if (pathname === '/api/save' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const tasksPath = path.join(cwd, 'tasks.json');
          await fs.outputJson(tasksPath, data, { spaces: 2 });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, path: path.relative(cwd, tasksPath) }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Static File Serving
    let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\') safePath = 'index.html';
    const filePath = path.join(webDir, safePath);

    if (await fs.pathExists(filePath) && !(await fs.stat(filePath)).isDirectory()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.clearAndBanner();
    logger.success(`APM Task Manager Web UI is running!`);
    logger.info(`Server URL: http://127.0.0.1:${port}`);
    logger.info('Press Ctrl+C to stop the server.');
    logger.blank();

    // Auto open browser
    const url = `http://127.0.0.1:${port}`;
    const startCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${startCmd} ${url}`, (err) => {
      if (err) {
        logger.warn(`Could not open browser automatically. Please open: ${url}`);
      }
    });
  });
}

export default uiCommand;
