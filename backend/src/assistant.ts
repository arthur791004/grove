// Inline AI assistant — spawns `claude -p` in the tab's cwd, streams stdout
// to the client over Server-Sent Events. No Anthropic SDK, no API key UI:
// reuses whatever Claude auth the user already has working with the CLI.
//
// Wire format (each line is one SSE event):
//   data: {"type":"delta","content":"..."}
//   data: {"type":"done"}
//   data: {"type":"error","message":"..."}
//
// Cancelling the HTTP request kills the child process.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { sessionCwd } from './sessions.js';
import { expandHome } from './gitUtil.js';

interface AssistantBody {
  tabId?: string;
  prompt: string;
  context: {
    filePath: string;
    language: string;
    selectedText: string;
    surroundingLines: string;
    selectionRange: { fromLine: number; toLine: number };
  };
}

const MAX_SELECTION_LINES = 200;
const MAX_SURROUND_BYTES = 32 * 1024;

function buildSystemPrompt(ctx: AssistantBody['context']): string {
  const surround = ctx.surroundingLines.slice(0, MAX_SURROUND_BYTES);
  return [
    `You are an inline code assistant inside Grove, a developer terminal.`,
    `The user has selected code from ${ctx.filePath} and asked you to help with it.`,
    ``,
    `Respond with ONLY the modified version of the selected code — no explanation,`,
    `no markdown code fences, no preamble. Just the modified code that should`,
    `replace the user's selection. Preserve the surrounding indentation style.`,
    ``,
    `If the user asks for an explanation rather than a change, respond with a`,
    `concise plain-text explanation, also without markdown fences.`,
    ``,
    `File: ${ctx.filePath}`,
    `Language: ${ctx.language}`,
    `Selected lines: ${ctx.selectionRange.fromLine}-${ctx.selectionRange.toLine}`,
    ``,
    `Surrounding context:`,
    surround,
  ].join('\n');
}

function truncateSelection(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= MAX_SELECTION_LINES) return text;
  return lines.slice(0, MAX_SELECTION_LINES).join('\n');
}

export function registerAssistantRoutes(app: FastifyInstance) {
  app.post<{ Body: AssistantBody }>('/assistant/run', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body.prompt !== 'string' || !body.context) {
      reply.code(400).send({ error: 'Invalid request' });
      return;
    }

    const sessCwd = body.tabId ? sessionCwd(body.tabId) : null;
    const cwd = expandHome(sessCwd || os.homedir());

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // CORS is already wired globally, but SSE through some proxies needs
      // this hint to disable buffering.
      'x-accel-buffering': 'no',
    });

    const send = (event: object) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Connection closed mid-write; the abort handler will tear down.
      }
    };

    const systemPrompt = buildSystemPrompt(body.context);
    const userMessage = [
      `Selected code:`,
      truncateSelection(body.context.selectedText),
      ``,
      `User prompt: ${body.prompt}`,
    ].join('\n');

    const child = spawn(
      'claude',
      ['-p', userMessage, '--append-system-prompt', systemPrompt],
      { cwd, env: process.env },
    );

    let stderrBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      send({ type: 'delta', content: chunk.toString('utf8') });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      const msg =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'claude CLI not found on PATH. Install Claude Code to use the inline assistant.'
          : String(err.message || err);
      send({ type: 'error', message: msg });
      try {
        reply.raw.end();
      } catch {}
    });

    child.on('close', (code) => {
      if (code === 0) {
        send({ type: 'done' });
      } else {
        const msg = stderrBuf.trim() || `claude exited with code ${code}`;
        send({ type: 'error', message: msg });
      }
      try {
        reply.raw.end();
      } catch {}
    });

    // Client cancellation: kill the child, let close handler send done/error.
    req.raw.on('close', () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    });

    // Keep fastify from treating this as a regular reply.
    return reply;
  });
}

// Re-export for convenience so unused-import lints don't flag the type guard.
export type { AssistantBody, FastifyReply, FastifyRequest };
