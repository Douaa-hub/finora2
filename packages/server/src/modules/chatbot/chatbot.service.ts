import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  OnModuleInit,
  OnModuleDestroy,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { spawn, exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import OpenAI from 'openai';
import pdfParse from 'pdf-parse';
import { PrismaService } from '../../../prisma/prisma.service';
import { MinioService } from '../../common/services/minio.service';
import { CHATBOT_TOOLS } from './chatbot.tools';
import { buildSystemPrompt, type AssistantContext } from './chatbot.context';
import { AiInsightsService } from './ai-insights.service';
import type { ChatAttachmentMeta } from './dto/chat-message.dto';

const execAsync = promisify(exec);

// ─── Confirmation types ────────────────────────────────────────────────────────

interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  userId: number;
  companyId: number;
  expiresAt: number;
}

// ─── Auto-generate a short session title from the first user message ──────────
function generateTitle(message: string): string {
  const cleaned = message.trim().replace(/[?!.]+$/, '');
  return cleaned.length > 50 ? cleaned.slice(0, 47) + '…' : cleaned;
}

@Injectable()
export class ChatbotService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(ChatbotService.name);
  private readonly openai: OpenAI;

  private whisperProcess: ChildProcess | null = null;
  private whisperReady = false;
  private whisperPort = 8765;
  /** In-flight startup — guarantees a single spawn attempt at any time. */
  private whisperStartPromise: Promise<void> | null = null;
  /** Guard so process-level shutdown listeners are registered only once. */
  private shutdownGuardsRegistered = false;

  // Write tools that require explicit user confirmation before execution
  private static readonly WRITE_TOOLS = new Set([
    'mark_invoice_paid',
    'create_task',
    'create_appointment',
  ]);

  // In-memory store for pending confirmations — keyed by UUID, TTL 5 min
  private readonly pendingActions = new Map<string, PendingAction>();

  private static readonly ALLOWED_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/avif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
    'audio/mpeg',
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly aiInsightsService: AiInsightsService,
    private readonly minioService: MinioService
  ) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const useOpenRouter = this.config.get<string>('USE_OPENROUTER') === 'true';

    if (useOpenRouter) {
      this.openai = new OpenAI({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': this.config.get<string>('FRONTEND_URL') || 'http://localhost:3039',
          'X-Title': 'Finora Assistant',
        },
      });
      this.logger.log('Chatbot configured with OpenRouter');
    } else {
      this.openai = new OpenAI({ apiKey });
      this.logger.log('Chatbot configured with OpenAI');
    }

    this.whisperPort = parseInt(this.config.get<string>('WHISPER_PORT') ?? '8765', 10);
  }

  async onModuleInit(): Promise<void> {
    this.registerShutdownGuards();
    await this.ensureWhisperService();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopWhisperService();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stopWhisperService();
  }

  private findWhisperScript(): string | null {
    // Walk up from __dirname (up to 6 levels) to find whisper_service.py.
    // Needed because the compiled depth varies: NestJS CLI strips `src/` from
    // output paths (dist/modules/…) while plain tsc keeps it (dist/src/modules/…).
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'whisper_service.py');
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
    return null;
  }

  private async findPython(): Promise<string | null> {
    for (const cmd of ['python', 'python3']) {
      try {
        await execAsync(`${cmd} --version`);
        return cmd;
      } catch {
        // not found, try next
      }
    }
    return null;
  }

  private async spawnWhisperService(): Promise<void> {
    // Walk up from __dirname to find whisper_service.py. The exact depth varies
    // depending on whether NestJS compiled with sourceRoot stripping (dist/modules/…)
    // or plain tsc (dist/src/modules/…), so we search rather than hardcode.
    const scriptPath = this.findWhisperScript();
    if (!scriptPath) {
      this.logger.warn('[whisper] whisper_service.py not found — audio transcription disabled');
      return;
    }
    this.logger.log(`[whisper] script found at: ${scriptPath}`);

    const python = await this.findPython();
    if (!python) {
      this.logger.warn(
        '[whisper] Python not found — audio transcription disabled. Install Python and run: pip install faster-whisper'
      );
      return;
    }

    const model = this.config.get<string>('WHISPER_MODEL') ?? 'small';
    const env = {
      ...process.env,
      WHISPER_MODEL: model,
      WHISPER_PORT: String(this.whisperPort),
    };

    this.logger.log(
      `[whisper] Spawning local Whisper service (model=${model}, port=${this.whisperPort})...`
    );

    this.whisperProcess = spawn(python, [scriptPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const proc = this.whisperProcess;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.warn('[whisper] Startup timeout (90s) — continuing without transcription');
        resolve();
      }, 90_000);

      proc.stdout?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) this.logger.log(`[whisper-py] ${line}`);
        // Only "Listening on" proves the HTTP server actually bound the port.
        // "Model ready" is printed earlier, *before* the bind — trusting it made
        // the service look ready even when the bind later failed (port taken),
        // which is exactly what produced the silent voice-message fallback.
        if (line.includes('Listening on')) {
          clearTimeout(timeout);
          this.whisperReady = true;
          this.logger.log('Local Whisper transcription enabled');
          resolve();
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) this.logger.warn(`[whisper-py] ${line}`);
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        this.whisperReady = false;
        this.whisperProcess = null;
        if (code !== 0) {
          this.logger.warn(
            `[whisper] Process exited (code=${code}) — audio transcription disabled`
          );
        }
        resolve();
      });
    });
  }

  /**
   * Idempotent entry point for bringing up the local Whisper service.
   *  - never starts a second instance while one is running or starting
   *  - reuses an instance already listening on the port (e.g. left over from a
   *    previous backend process that did not shut down cleanly)
   *  - logs an explicit error when the port is held by something that is not Whisper
   */
  private async ensureWhisperService(): Promise<void> {
    if (this.whisperReady && this.whisperProcess) return;
    if (this.whisperStartPromise) return this.whisperStartPromise;

    this.whisperStartPromise = (async () => {
      // A child we own is already alive — nothing to do.
      if (this.whisperProcess && this.whisperProcess.exitCode === null) return;

      const probe = await this.probeWhisperService();
      if (probe === 'whisper') {
        this.whisperReady = true;
        this.logger.log(
          `[whisper] Reusing Whisper service already listening on 127.0.0.1:${this.whisperPort}`
        );
        return;
      }
      if (probe === 'occupied') {
        this.logger.error(
          `[whisper] Port ${this.whisperPort} is in use by a process that is NOT the Whisper service — ` +
            `audio transcription disabled. Stop that process or set WHISPER_PORT to a free port.`
        );
        return;
      }
      // probe === 'free' → safe to spawn a fresh instance
      await this.spawnWhisperService();
    })();

    try {
      await this.whisperStartPromise;
    } finally {
      this.whisperStartPromise = null;
    }
  }

  /**
   * Inspect what — if anything — is listening on 127.0.0.1:WHISPER_PORT.
   *  'whisper'  → the transcription service answered with its known JSON shape
   *  'occupied' → something holds the port but it is not our Whisper service
   *  'free'     → nothing is listening; safe to spawn
   */
  private probeWhisperService(): Promise<'whisper' | 'occupied' | 'free'> {
    return new Promise((resolve) => {
      const body = JSON.stringify({ ping: true });
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.whisperPort,
          path: '/transcribe',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 2000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => {
            data += c;
          });
          res.on('end', () => {
            // whisper_service.py always replies with JSON holding `text` or `error`.
            try {
              const parsed = JSON.parse(data) as { text?: string; error?: string };
              if (typeof parsed.text === 'string' || typeof parsed.error === 'string') {
                resolve('whisper');
                return;
              }
            } catch {
              /* not JSON → not our service */
            }
            resolve('occupied');
          });
        }
      );

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (
          err.code === 'ECONNREFUSED' ||
          err.code === 'ECONNRESET' ||
          err.code === 'EHOSTUNREACH'
        ) {
          resolve('free');
        } else {
          this.logger.warn(`[whisper] Port probe error (${err.code ?? err.message})`);
          resolve('occupied');
        }
      });
      req.on('timeout', () => {
        req.destroy();
        // Connection accepted but no answer → something is holding the port.
        resolve('occupied');
      });

      req.write(body);
      req.end();
    });
  }

  /** Terminate the Whisper child process. Idempotent and Windows-safe. */
  private async stopWhisperService(): Promise<void> {
    const proc = this.whisperProcess;
    this.whisperReady = false;
    this.whisperProcess = null;
    if (!proc || proc.exitCode !== null || proc.killed) return;

    const pid = proc.pid;
    if (process.platform === 'win32' && pid) {
      // SIGTERM is emulated on Windows and often leaves the HTTP listener alive,
      // keeping port 8765 held after a restart. taskkill /T kills the whole tree,
      // /F forces it.
      await new Promise<void>((resolve) => {
        try {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
          });
          killer.on('exit', () => resolve());
          killer.on('error', () => {
            try {
              proc.kill();
            } catch {
              /* already gone */
            }
            resolve();
          });
        } catch {
          resolve();
        }
      });
    } else {
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (proc.exitCode === null && !proc.killed) {
            try {
              proc.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
        }, 2000).unref();
      } catch {
        /* already gone */
      }
    }
    this.logger.log('[whisper] Local Whisper service stopped');
  }

  /**
   * NestJS lifecycle hooks only fire when shutdown hooks are enabled and the app
   * closes gracefully. `nest start --watch` restarts and a bare Ctrl+C can bypass
   * that — which is precisely how a stale whisper_service.py ends up holding
   * port 8765. These process-level guards are the last line of defence.
   */
  private registerShutdownGuards(): void {
    if (this.shutdownGuardsRegistered) return;
    this.shutdownGuardsRegistered = true;

    // Synchronous best-effort kill on hard exit.
    process.once('exit', () => {
      const proc = this.whisperProcess;
      if (proc && proc.exitCode === null && !proc.killed) {
        try {
          if (process.platform === 'win32' && proc.pid) {
            spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
          } else {
            proc.kill('SIGKILL');
          }
        } catch {
          /* nothing else we can do at this point */
        }
      }
    });

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void this.stopWhisperService().finally(() => {
          // Listener was `once` → re-raising now runs the default behaviour so
          // Nest and any other handlers still get to shut down.
          process.kill(process.pid, signal);
        });
      });
    }
  }

  private callWhisperService(audioBase64: string, mime: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ audio: audioBase64, mime });
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: this.whisperPort,
        path: '/transcribe',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { text?: string; error?: string };
            if (parsed.error) return reject(new Error(parsed.error));
            resolve(parsed.text ?? '');
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(120_000, () => {
        req.destroy(new Error('Whisper timeout (>120s)'));
      });
      req.write(body);
      req.end();
    });
  }

  // ─── Session management ───────────────────────────────────────────────────

  async getSessions(userId: number, companyId: number) {
    const sessions = await this.prisma.chatbotSession.findMany({
      where: { userId, companyId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true, role: true, createdAt: true },
        },
      },
    });

    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastMessage: s.messages[0] ?? null,
    }));
  }

  async getSession(sessionId: number, userId: number) {
    const session = await this.prisma.chatbotSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            role: true,
            content: true,
            transcription: true,
            toolsUsed: true,
            createdAt: true,
            attachmentObjectPath: true,
            attachmentName: true,
            attachmentMimeType: true,
            attachmentSize: true,
          },
        },
      },
    });

    if (!session || session.userId !== userId) {
      return null;
    }

    // Regenerate fresh presigned URLs for messages that have attachments
    const messages = await Promise.all(
      session.messages.map(async (msg) => {
        if (!msg.attachmentObjectPath) {
           
          const {
            attachmentObjectPath,
            attachmentName,
            attachmentMimeType,
            attachmentSize,
            ...rest
          } = msg;
          return rest;
        }
        try {
          const url = await this.minioService.getPresignedUrl(msg.attachmentObjectPath, 3600);
          const {
            attachmentObjectPath,
            attachmentName,
            attachmentMimeType,
            attachmentSize,
            ...rest
          } = msg;
          return {
            ...rest,
            attachment: {
              url,
              name: attachmentName!,
              mimeType: attachmentMimeType!,
              size: attachmentSize!,
              objectPath: attachmentObjectPath,
            } satisfies ChatAttachmentMeta,
          };
        } catch {
          const {
            attachmentObjectPath,
            attachmentName,
            attachmentMimeType,
            attachmentSize,
            ...rest
          } = msg;
          return rest;
        }
      })
    );

    return { ...session, messages };
  }

  async deleteSession(sessionId: number, userId: number) {
    const session = await this.prisma.chatbotSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.userId !== userId) return false;

    await this.prisma.chatbotSession.delete({ where: { id: sessionId } });
    return true;
  }

  async renameSession(sessionId: number, userId: number, title: string) {
    const session = await this.prisma.chatbotSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.userId !== userId) return null;

    return this.prisma.chatbotSession.update({
      where: { id: sessionId },
      data: { title: title.slice(0, 100) },
      select: { id: true, title: true },
    });
  }

  // ─── File upload ──────────────────────────────────────────────────────────

  async uploadAttachment(
    companyId: number,
    file: Express.Multer.File
  ): Promise<{ status: string; data: ChatAttachmentMeta }> {
    this.logger.log(
      `[upload] companyId=${companyId} name="${file?.originalname}" mime="${file?.mimetype}" size=${file?.size} buffer=${file?.buffer ? 'ok' : 'MISSING'}`
    );

    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Le fichier reçu est vide ou corrompu.');
    }

    if (!ChatbotService.ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`Type de fichier non autorisé : ${file.mimetype}`);
    }
    if (file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('Fichier trop volumineux (maximum 10 Mo)');
    }

    let objectPath: string;
    let url: string;
    try {
      objectPath = await this.minioService.uploadFile(companyId, 'chatbot', file);
      this.logger.log(`[upload] MinIO upload OK → ${objectPath}`);
      url = await this.minioService.getPresignedUrl(objectPath, 3600);
      this.logger.log(`[upload] Presigned URL generated`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[upload] MinIO error: ${msg}`);
      throw new InternalServerErrorException(`Erreur de stockage : ${msg}`);
    }

    return {
      status: 'success',
      data: { url, name: file.originalname, mimeType: file.mimetype, size: file.size, objectPath },
    };
  }

  // ─── Main chat ────────────────────────────────────────────────────────────

  async chat(
    userId: number,
    companyId: number,
    message: string,
    sessionId?: number,
    attachment?: ChatAttachmentMeta
  ): Promise<{ reply: string; toolsUsed: string[]; sessionId: number }> {
    const toolsUsed: string[] = [];

    // ── Transcribe audio attachment ────────────────────────────────────────
    let effectiveMessage = message;
    let isAudioAttachment = false;
    let transcriptionSucceeded = false;

    if (attachment && ChatbotService.AUDIO_MIME_TYPES.has(attachment.mimeType)) {
      isAudioAttachment = true;
      this.logger.log(
        `[voice] received audio: mime=${attachment.mimeType} path=${attachment.objectPath}`
      );
      const transcription = await this.transcribeAudio(attachment);
      this.logger.log(
        `[voice] transcription result: "${transcription ?? 'null/empty'}" (length=${transcription?.length ?? 0})`
      );
      if (transcription && transcription.trim().length >= 2) {
        effectiveMessage = transcription.trim();
        transcriptionSucceeded = true;
        this.logger.log(`[voice] effectiveMessage set to: "${effectiveMessage.slice(0, 100)}"`);
      } else {
        this.logger.warn(`[voice] transcription empty or failed — will return fallback`);
      }
    }

    // ── Resolve or create session ──────────────────────────────────────────
    let session: { id: number; title: string };

    if (sessionId) {
      const existing = await this.prisma.chatbotSession.findUnique({
        where: { id: sessionId },
      });
      if (!existing || existing.userId !== userId) {
        throw new NotFoundException(
          'Session introuvable. Veuillez démarrer une nouvelle conversation.'
        );
      }
      session = existing;
    } else {
      session = await this.prisma.chatbotSession.create({
        data: {
          userId,
          companyId,
          title: generateTitle(effectiveMessage) || (attachment?.name ?? 'Nouvelle conversation'),
        },
        select: { id: true, title: true },
      });
    }

    // ── Persist user message ───────────────────────────────────────────────
    await this.prisma.chatbotMessage.create({
      data: {
        sessionId: session.id,
        role: 'user',
        content: message,
        transcription: transcriptionSucceeded ? effectiveMessage : null,
        toolsUsed: [],
        attachmentObjectPath: attachment?.objectPath,
        attachmentName: attachment?.name,
        attachmentMimeType: attachment?.mimeType,
        attachmentSize: attachment?.size,
      },
    });

    // ── Guard: audio with failed transcription — skip LLM, reply with clarification ──
    if (isAudioAttachment && !transcriptionSucceeded) {
      const fallbackReply =
        "Je n'ai pas bien compris votre message vocal. Pouvez-vous le répéter ou l'écrire ?";
      await this.prisma.chatbotMessage.create({
        data: { sessionId: session.id, role: 'assistant', content: fallbackReply, toolsUsed: [] },
      });
      await this.prisma.chatbotSession.update({
        where: { id: session.id },
        data: { updatedAt: new Date() },
      });
      return { reply: fallbackReply, toolsUsed: [], sessionId: session.id };
    }

    // ── Load history + context in parallel (no extra round-trip cost) ────────
    const [dbHistory, ctx] = await Promise.all([
      this.prisma.chatbotMessage.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: { role: true, content: true, transcription: true },
      }),
      this.fetchAssistantContext(userId, companyId),
    ]);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(ctx) },
      ...dbHistory
        .reverse()
        .slice(-40)
        .map((h) => {
          const raw = h.transcription ?? h.content;
          const cleaned = raw
            .split('\n')
            .filter((line) => !/^\[(?:Fichier joint|Image jointe)\s*:/i.test(line.trim()))
            .join('\n')
            .trim();
          return { role: h.role as 'user' | 'assistant', content: cleaned };
        })
        .filter((m) => m.content.length > 0 && !/^\[Message vocal\s*:/i.test(m.content)),
    ];

    // Guarantee the current user turn is present even when content="" (PDF-only send).
    // The filter above strips empty-content entries, which would cause injectPdfContent
    // to find no user message at the end and skip injection entirely.
    if (messages[messages.length - 1]?.role !== 'user') {
      messages.push({ role: 'user', content: effectiveMessage });
    }

    // Upgrade the last user message to vision content if an image was attached
    await this.injectVisionContent(messages, attachment);
    // Inject PDF text if a PDF was attached
    await this.injectPdfContent(messages, attachment);

    // Debug: log last 3 messages sent to OpenAI
    {
      const debugMsgs = messages.slice(-3).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content.slice(0, 120) : '[vision/non-text]',
      }));
      this.logger.log(
        `[voice] last ${debugMsgs.length} messages sent to OpenAI: ${JSON.stringify(debugMsgs)}`
      );
    }

    // ── Agentic loop ───────────────────────────────────────────────────────
    let iterations = 0;
    const MAX_ITERATIONS = 5;
    let finalReply = "Je suis désolé, je n'ai pas pu compléter votre demande. Veuillez réessayer.";

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const response = await this.openai.chat.completions.create(
          {
            model: this.config.get<string>('OPENAI_MODEL') || 'gpt-4o-mini',
            messages,
            tools: CHATBOT_TOOLS,
            tool_choice: 'auto',
            temperature: 0.4,
            max_tokens: 1500,
          },
          { signal: AbortSignal.timeout(45_000) }
        );

        const choice = response.choices[0];
        if (!choice) break;

        if (choice.finish_reason === 'stop' || !choice.message.tool_calls?.length) {
          finalReply = choice.message.content ?? finalReply;
          break;
        }

        messages.push(choice.message);

        for (const toolCall of choice.message.tool_calls) {
          const fn = toolCall.type === 'function' ? toolCall.function : null;
          if (!fn) continue;

          const toolName = fn.name;
          if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName);

          let toolArgs: any = {};
          try {
            toolArgs = JSON.parse(fn.arguments);
          } catch {
            this.logger.warn(`Failed to parse tool args for ${toolName}`);
          }

          this.logger.log(`Executing tool: ${toolName}`);

          let toolResult: any;
          try {
            toolResult = await this.executeTool(toolName, toolArgs, userId, companyId);
          } catch (err: any) {
            toolResult = { error: err.message || 'Tool execution failed' };
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        }
      }
    } catch (err: any) {
      const isTimeout =
        err?.name === 'TimeoutError' ||
        err?.name === 'AbortError' ||
        err?.constructor?.name === 'APIUserAbortError' ||
        (typeof err?.message === 'string' && err.message.toLowerCase().includes('aborted'));

      if (isTimeout) {
        this.logger.warn('OpenAI request timed out after 45s');
        finalReply =
          "L'assistant a mis trop de temps à répondre. Veuillez réessayer dans quelques instants.";
      } else {
        this.logger.error('Unexpected error in chat loop', err);
        throw err;
      }
    }

    // ── Persist assistant reply ────────────────────────────────────────────
    await this.prisma.chatbotMessage.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: finalReply,
        toolsUsed,
      },
    });

    // Update session timestamp
    await this.prisma.chatbotSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });

    return { reply: finalReply, toolsUsed, sessionId: session.id };
  }

  // ─── SSE Streaming Chat ───────────────────────────────────────────────────

  async chatStream(
    userId: number,
    companyId: number,
    message: string,
    sessionId: number | undefined,
    confirmId: string | undefined,
    attachment: ChatAttachmentMeta | undefined,
    emit: (event: string, data: Record<string, unknown>) => void
  ): Promise<void> {
    const toolsUsed: string[] = [];

    // Validate: __CONFIRM__ requires an existing sessionId
    if (message === '__CONFIRM__' && !sessionId) {
      emit('error', { message: 'Session requise pour confirmer une action.' });
      return;
    }

    // ── Transcribe audio attachment before session creation ────────────────
    let effectiveMessage = message;
    let isAudioAttachment = false;
    let transcriptionSucceeded = false;

    if (
      message !== '__CONFIRM__' &&
      attachment &&
      ChatbotService.AUDIO_MIME_TYPES.has(attachment.mimeType)
    ) {
      isAudioAttachment = true;
      this.logger.log(
        `[voice] received audio: mime=${attachment.mimeType} path=${attachment.objectPath} label="${message.slice(0, 60)}"`
      );
      const transcription = await this.transcribeAudio(attachment);
      this.logger.log(
        `[voice] transcription result: "${transcription ?? 'null/empty'}" (length=${transcription?.length ?? 0})`
      );
      if (transcription && transcription.trim().length >= 2) {
        effectiveMessage = transcription.trim();
        transcriptionSucceeded = true;
        this.logger.log(`[voice] effectiveMessage set to: "${effectiveMessage.slice(0, 100)}"`);
      } else {
        this.logger.warn(
          `[voice] transcription empty or failed — will return fallback without calling LLM`
        );
      }
    }

    // ── Resolve or create session ──────────────────────────────────────────
    let session: { id: number; title: string };

    if (sessionId) {
      const existing = await this.prisma.chatbotSession.findUnique({ where: { id: sessionId } });
      if (!existing || existing.userId !== userId) {
        emit('error', {
          message: 'Session introuvable. Veuillez démarrer une nouvelle conversation.',
        });
        return;
      }
      session = existing;
    } else {
      session = await this.prisma.chatbotSession.create({
        data: {
          userId,
          companyId,
          title: generateTitle(effectiveMessage) || (attachment?.name ?? 'Nouvelle conversation'),
        },
        select: { id: true, title: true },
      });
    }

    // Early exit: user confirmed a pending write action — skip LLM entirely
    if (message === '__CONFIRM__' && confirmId) {
      await this.runPendingAction(userId, companyId, confirmId, session.id, emit);
      return;
    }

    // ── Persist user message ───────────────────────────────────────────────
    // Save BEFORE emitting message_start so that when the frontend's
    // useGetSessionQuery fires (triggered by the sessionId in message_start),
    // the user message is already in the DB and the attachment card renders.
    await this.prisma.chatbotMessage.create({
      data: {
        sessionId: session.id,
        role: 'user',
        content: message,
        transcription: transcriptionSucceeded ? effectiveMessage : null,
        toolsUsed: [],
        attachmentObjectPath: attachment?.objectPath,
        attachmentName: attachment?.name,
        attachmentMimeType: attachment?.mimeType,
        attachmentSize: attachment?.size,
      },
    });

    emit('message_start', { sessionId: session.id });

    // ── Guard: audio with failed transcription — skip LLM, reply with clarification ──
    if (isAudioAttachment && !transcriptionSucceeded) {
      const fallbackReply =
        "Je n'ai pas bien compris votre message vocal. Pouvez-vous le répéter ou l'écrire ?";
      await this.prisma.chatbotMessage.create({
        data: { sessionId: session.id, role: 'assistant', content: fallbackReply, toolsUsed: [] },
      });
      await this.prisma.chatbotSession.update({
        where: { id: session.id },
        data: { updatedAt: new Date() },
      });
      emit('token', { content: fallbackReply });
      emit('message_done', {
        sessionId: session.id,
        toolsUsed: [],
        reply: fallbackReply,
        wasExecuted: false,
        userTranscription: null,
      });
      return;
    }

    // ── Load history + context in parallel ────────────────────────────────
    const [dbHistory, ctx] = await Promise.all([
      this.prisma.chatbotMessage.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: { role: true, content: true, transcription: true },
      }),
      this.fetchAssistantContext(userId, companyId),
    ]);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(ctx) },
      ...dbHistory
        .reverse()
        .slice(-40)
        .map((h) => {
          const raw = h.transcription ?? h.content;
          const cleaned = raw
            .split('\n')
            .filter((line) => !/^\[(?:Fichier joint|Image jointe)\s*:/i.test(line.trim()))
            .join('\n')
            .trim();
          return { role: h.role as 'user' | 'assistant', content: cleaned };
        })
        .filter((m) => m.content.length > 0 && !/^\[Message vocal\s*:/i.test(m.content)),
    ];

    // Guarantee the current user turn is present even when content="" (PDF-only send).
    if (messages[messages.length - 1]?.role !== 'user') {
      messages.push({ role: 'user', content: effectiveMessage });
    }

    // Upgrade the last user message to vision content if an image was attached
    await this.injectVisionContent(messages, attachment);
    // Inject PDF text if a PDF was attached
    await this.injectPdfContent(messages, attachment);

    // ── Agentic loop with streaming ────────────────────────────────────────
    let iterations = 0;
    const MAX_ITERATIONS = 5;
    let finalReply = "Je suis désolé, je n'ai pas pu compléter votre demande. Veuillez réessayer.";
    let confirmationPending = false; // lifted so message_done can read it

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        if (iterations === 1) {
          const debugMsgs = messages.slice(-3).map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content.slice(0, 120) : '[vision/non-text]',
          }));
          this.logger.log(
            `[voice] last ${debugMsgs.length} messages sent to OpenAI: ${JSON.stringify(debugMsgs)}`
          );
        }

        const stream = await this.openai.chat.completions.create(
          {
            model: this.config.get<string>('OPENAI_MODEL') || 'gpt-4o-mini',
            messages,
            tools: CHATBOT_TOOLS,
            tool_choice: 'auto',
            temperature: 0.4,
            max_tokens: 1500,
            stream: true as const,
          },
          { signal: AbortSignal.timeout(90_000) }
        );

        let contentBuffer = '';
        const toolCallBuffers: { id: string; function: { name: string; arguments: string } }[] = [];
        let finishReason: string | null = null;

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;

          const delta = choice.delta;

          if (delta.content) {
            contentBuffer += delta.content;
            emit('token', { content: delta.content });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallBuffers[idx]) {
                toolCallBuffers[idx] = {
                  id: tc.id ?? '',
                  function: {
                    name: tc.function?.name ?? '',
                    arguments: tc.function?.arguments ?? '',
                  },
                };
              } else {
                if (tc.function?.arguments)
                  toolCallBuffers[idx].function.arguments += tc.function.arguments;
              }
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        }

        const hasToolCalls = toolCallBuffers.length > 0;

        if (!hasToolCalls || finishReason === 'stop') {
          finalReply = contentBuffer || finalReply;
          break;
        }

        // Reconstruct assistant message with buffered tool calls
        messages.push({
          role: 'assistant',
          content: contentBuffer || null,
          tool_calls: toolCallBuffers.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });

        // Execute tools — intercept write tools for user confirmation
        for (const tc of toolCallBuffers) {
          const toolName = tc.function.name;
          if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName);

          let toolArgs: any = {};
          try {
            toolArgs = JSON.parse(tc.function.arguments);
          } catch {
            this.logger.warn(`Failed to parse tool args for ${toolName}`);
          }

          if (ChatbotService.WRITE_TOOLS.has(toolName)) {
            const cId = randomUUID();
            const summary = this.buildActionSummary(toolName, toolArgs as Record<string, unknown>);
            this.pendingActions.set(cId, {
              tool: toolName,
              args: toolArgs as Record<string, unknown>,
              userId,
              companyId,
              expiresAt: Date.now() + 5 * 60 * 1000,
            });
            emit('confirm_required', { confirmId: cId, tool: toolName, summary });
            finalReply = summary;
            confirmationPending = true;
            break;
          }

          emit('tool_start', { tool: toolName });
          this.logger.log(`Executing tool (stream): ${toolName}`);

          let toolResult: any;
          try {
            toolResult = await this.executeTool(toolName, toolArgs, userId, companyId);
          } catch (err: any) {
            toolResult = { error: err.message || 'Tool execution failed' };
          }

          emit('tool_result', { tool: toolName, result: toolResult });

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult),
          });
        }

        if (confirmationPending) break;
      }
    } catch (err: any) {
      const isTimeout =
        err?.name === 'TimeoutError' ||
        err?.name === 'AbortError' ||
        err?.constructor?.name === 'APIUserAbortError' ||
        (typeof err?.message === 'string' && err.message.toLowerCase().includes('aborted'));

      if (isTimeout) {
        this.logger.warn('OpenAI stream timed out after 90s');
        emit('error', {
          message:
            "L'assistant a mis trop de temps à répondre. Veuillez réessayer dans quelques instants.",
        });
      } else {
        this.logger.error('Unexpected error in chatStream', err);
        emit('error', { message: "Une erreur inattendue s'est produite." });
      }
      return;
    }

    // ── Persist assistant reply ────────────────────────────────────────────
    await this.prisma.chatbotMessage.create({
      data: { sessionId: session.id, role: 'assistant', content: finalReply, toolsUsed },
    });

    await this.prisma.chatbotSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });

    emit('message_done', {
      sessionId: session.id,
      toolsUsed,
      reply: finalReply,
      wasExecuted: !confirmationPending,
      userTranscription: effectiveMessage !== message ? effectiveMessage : null,
    });
  }

  // ─── Confirmation helpers ─────────────────────────────────────────────────

  private buildActionSummary(tool: string, args: Record<string, unknown>): string {
    switch (tool) {
      case 'mark_invoice_paid':
        return `Marquer la facture #${args.invoiceId} comme payée intégralement`;
      case 'create_task':
        return `Créer une tâche : "${args.title}"${args.priority ? ` (priorité : ${args.priority})` : ''}${args.dueDate ? `, échéance : ${args.dueDate}` : ''}`;
      case 'create_appointment':
        return `Créer un rendez-vous : "${args.title}" le ${args.date} à ${args.hour}`;
      default:
        return `Exécuter l'action : ${tool}`;
    }
  }

  private async runPendingAction(
    userId: number,
    companyId: number,
    confirmId: string,
    sessionId: number,
    emit: (event: string, data: Record<string, unknown>) => void
  ): Promise<void> {
    // Prune expired entries
    const now = Date.now();
    for (const [id, action] of this.pendingActions) {
      if (action.expiresAt < now) this.pendingActions.delete(id);
    }

    const pending = this.pendingActions.get(confirmId);
    if (!pending) {
      emit('error', { message: 'Action expirée ou introuvable. Veuillez réessayer.' });
      return;
    }

    // Tenant isolation guard
    if (pending.userId !== userId || pending.companyId !== companyId) {
      this.logger.warn(`Confirmation tenant mismatch: confirmId=${confirmId}`);
      emit('error', { message: 'Accès refusé.' });
      return;
    }

    this.pendingActions.delete(confirmId);

    emit('message_start', { sessionId });

    let toolResult: any;
    try {
      toolResult = await this.executeTool(pending.tool, pending.args, userId, companyId);
    } catch (err: any) {
      toolResult = { error: err.message || 'Tool execution failed' };
    }

    // Build LLM context with the tool result so it can produce a human-friendly reply
    const [dbHistory, ctx] = await Promise.all([
      this.prisma.chatbotMessage.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'asc' },
        take: 40,
        select: { role: true, content: true, transcription: true },
      }),
      this.fetchAssistantContext(userId, companyId),
    ]);

    const resultSentence = toolResult?.error
      ? `L'action a échoué : ${toolResult.error}`
      : `Action effectuée avec succès. Résultat : ${JSON.stringify(toolResult)}`;

    const llmMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(ctx) },
      ...dbHistory
        .slice(-40)
        .map((h) => ({
          role: h.role as 'user' | 'assistant',
          content: h.transcription ?? h.content,
        }))
        .filter((m) => !/^\[Message vocal\s*:/i.test(m.content)),
      {
        role: 'user',
        content: `[Action confirmée par l'utilisateur] ${resultSentence}. Présente le résultat de façon concise et professionnelle.`,
      },
    ];

    let finalReply = '';
    try {
      const stream = await this.openai.chat.completions.create(
        {
          model: this.config.get<string>('OPENAI_MODEL') || 'gpt-4o-mini',
          messages: llmMessages,
          temperature: 0.2,
          max_tokens: 600,
          stream: true as const,
        },
        { signal: AbortSignal.timeout(45_000) }
      );

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          finalReply += delta.content;
          emit('token', { content: delta.content });
        }
      }
    } catch {
      finalReply = toolResult?.message ?? JSON.stringify(toolResult);
      emit('token', { content: finalReply });
    }

    if (!finalReply) {
      finalReply = toolResult?.message ?? JSON.stringify(toolResult);
      emit('token', { content: finalReply });
    }

    await this.prisma.chatbotMessage.create({
      data: { sessionId, role: 'assistant', content: finalReply, toolsUsed: [pending.tool] },
    });

    await this.prisma.chatbotSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });

    emit('message_done', {
      sessionId,
      toolsUsed: [pending.tool],
      reply: finalReply,
      wasExecuted: true,
    });
  }

  // ─── Context Fetcher ──────────────────────────────────────────────────────

  private async fetchAssistantContext(
    userId: number,
    companyId: number
  ): Promise<AssistantContext> {
    const [user, company] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          firstName: true,
          lastName: true,
          position: true,
          role: { select: { nameFr: true } },
        },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          name: true,
          legalName: true,
          legalForm: true,
          type: true,
          sector: true,
          country: true,
        },
      }),
    ]);

    return {
      user: {
        id: userId,
        email: user?.email ?? '',
        firstName: user?.firstName,
        lastName: user?.lastName,
        position: user?.position,
        roleName: user?.role?.nameFr,
      },
      company: {
        id: companyId,
        name: company?.name ?? 'Votre entreprise',
        legalName: company?.legalName,
        legalForm: company?.legalForm,
        type: company?.type,
        sector: company?.sector,
        country: company?.country,
      },
    };
  }

  // ─── Audio / Vision helpers ───────────────────────────────────────────────

  private static readonly AUDIO_MIME_TYPES = new Set([
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
  ]);

  private static readonly VISION_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

  private static readonly PDF_MIME_TYPES = new Set(['application/pdf']);

  private static readonly PDF_MAX_CHARS = 8000;

  private async transcribeAudio(attachment: ChatAttachmentMeta): Promise<string | null> {
    if (!this.whisperReady) {
      this.logger.warn('[audio] Local Whisper service not ready — skipping transcription');
      return null;
    }
    try {
      const buffer = await this.minioService.downloadFile(attachment.objectPath);
      const audioBase64 = buffer.toString('base64');
      const text = await this.callWhisperService(audioBase64, attachment.mimeType);
      this.logger.log(`[audio] transcribed ${buffer.length}b → "${text.slice(0, 80)}"`);
      return text || null;
    } catch (err: unknown) {
      this.logger.warn(
        `[audio] transcription failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /**
   * If the last message in `messages` is a user message and the attachment is
   * a supported image, replace its content with a vision content array so the
   * model can see the image. Falls back silently to text-only on any error.
   *
   * Downloads the image from MinIO and encodes it as a base64 data URL so the
   * data is embedded in the API request — no external URL reachability required.
   */
  private async injectVisionContent(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    attachment: ChatAttachmentMeta | undefined
  ): Promise<void> {
    if (!attachment || !ChatbotService.VISION_MIME_TYPES.has(attachment.mimeType)) return;

    try {
      const buffer = await this.minioService.downloadFile(attachment.objectPath);
      const base64 = buffer.toString('base64');
      const dataUrl = `data:${attachment.mimeType};base64,${base64}`;

      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user') return;

      const textContent = typeof last.content === 'string' ? last.content.trim() : '';

      const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
      if (textContent) parts.push({ type: 'text', text: textContent });
      parts.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } });

      messages[messages.length - 1] = { role: 'user', content: parts };
      this.logger.log(
        `[vision] base64 image injected — mime=${attachment.mimeType} size=${buffer.length}b parts=${parts.length}`
      );
    } catch (err: unknown) {
      this.logger.warn(
        `[vision] failed, falling back to text-only: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * If the last message in `messages` is a user message and the attachment is a PDF,
   * extract the text with pdf-parse and prepend it to the message content so the LLM
   * can read the document. Falls back silently on scanned/empty PDFs.
   */
  private async injectPdfContent(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    attachment: ChatAttachmentMeta | undefined
  ): Promise<void> {
    const isPdf =
      !!attachment &&
      (ChatbotService.PDF_MIME_TYPES.has(attachment.mimeType) ||
        attachment.mimeType.includes('pdf') ||
        attachment.name.toLowerCase().endsWith('.pdf'));
    this.logger.log(
      `[pdf-debug] enter injectPdfContent — isPdf=${isPdf} mimeType=${attachment?.mimeType ?? 'none'} fileName=${attachment?.name ?? 'none'} objectPath=${attachment?.objectPath ?? 'none'}`
    );

    if (!isPdf || !attachment) return;

    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') return;

    try {
      this.logger.log(`[pdf-debug] downloading from MinIO — objectPath=${attachment.objectPath}`);
      const buffer = await this.minioService.downloadFile(attachment.objectPath);
      this.logger.log(`[pdf-debug] buffer length=${buffer.length}`);

      this.logger.log(`[pdf-debug] pdfParse called`);
      const parsed = await pdfParse(buffer);
      const rawText = (parsed.text ?? '').trim();
      this.logger.log(
        `[pdf-debug] extracted text length=${rawText.length} preview="${rawText.slice(0, 200).replace(/\n/g, '↵')}"`
      );

      if (!rawText || rawText.length < 10) {
        this.logger.warn(
          `[pdf] extracted no usable text (scanned or empty PDF) — name="${attachment.name}"`
        );
        const textContent = typeof last.content === 'string' ? last.content.trim() : '';
        const notice = `[Ce fichier PDF ne contient pas de texte extractible — il s'agit probablement d'un document scanné ou d'une image. Informez l'utilisateur que vous ne pouvez pas lire son contenu.]`;
        messages[messages.length - 1] = {
          role: 'user',
          content: textContent ? `${textContent}\n\n${notice}` : notice,
        };
        return;
      }

      const excerpt =
        rawText.length > ChatbotService.PDF_MAX_CHARS
          ? rawText.slice(0, ChatbotService.PDF_MAX_CHARS) +
            '\n\n[… texte tronqué à 8000 caractères]'
          : rawText;

      this.logger.log(
        `[pdf] extracted ${rawText.length} chars, injecting ${excerpt.length} chars — name="${attachment.name}"`
      );

      const userText = typeof last.content === 'string' ? last.content.trim() : '';
      const injected = `[Contenu du fichier PDF "${attachment.name}" :\n---\n${excerpt}\n---]\n\n${userText}`;

      messages[messages.length - 1] = { role: 'user', content: injected };
    } catch (err: unknown) {
      this.logger.error(
        `[pdf] extraction FAILED — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
      );
    }
  }

  // ─── Tool Dispatcher ─────────────────────────────────────────────────────

  private async executeTool(
    name: string,
    args: any,
    userId: number,
    companyId: number
  ): Promise<any> {
    switch (name) {
      case 'get_invoices':
        return this.getInvoices(companyId, args);
      case 'get_invoice_by_id':
        return this.getInvoiceById(companyId, args.id);
      case 'create_invoice':
        return this.createInvoice(userId, companyId, args);
      case 'get_invoice_analytics':
        return this.getInvoiceAnalytics(companyId, args);
      case 'get_devis':
        return this.getDevis(companyId, args);
      case 'create_devis':
        return this.createDevis(userId, companyId, args);
      case 'get_suppliers':
        return this.getSuppliers(companyId, args);
      case 'get_bons_commande':
        return this.getBonsCommande(companyId, args);
      case 'calculate_tva':
        return this.calculateTva(args);
      case 'detect_anomalies':
        return this.detectAnomalies(companyId, args);
      case 'mark_invoice_paid':
        return this.markInvoicePaid(companyId, args);
      case 'create_task':
        return this.createTask(userId, companyId, args);
      case 'create_appointment':
        return this.createAppointment(userId, companyId, args);
      case 'get_financial_summary':
        return this.getFinancialSummary(companyId);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  // ─── Tool Implementations ─────────────────────────────────────────────────

  private async getInvoices(companyId: number, args: any) {
    const { page = 1, limit = 10, status, search, startDate, endDate } = args;
    const skip = (page - 1) * Math.min(limit, 50);
    const where: any = { companyId };

    if (status) where.status = status;
    if (search?.trim()) {
      where.OR = [
        { supplier: { name: { contains: search.trim(), mode: 'insensitive' } } },
        { supplier: { company: { contains: search.trim(), mode: 'insensitive' } } },
        { invoiceNumber: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [totalCount, invoices] = await Promise.all([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(limit, 50),
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          dueDate: true,
          total: true,
          amountPaid: true,
          remainingAmount: true,
          vatRate: true,
          subtotal: true,
          vatAmount: true,
          createdAt: true,
          supplier: { select: { id: true, name: true, company: true } },
        },
      }),
    ]);

    return {
      totalCount,
      page,
      invoices: invoices.map((inv) => ({
        ...inv,
        total: Number(inv.total),
        amountPaid: Number(inv.amountPaid),
        remainingAmount: Number(inv.remainingAmount),
        vatRate: Number(inv.vatRate),
        subtotal: Number(inv.subtotal),
        vatAmount: Number(inv.vatAmount),
      })),
    };
  }

  private async getInvoiceById(companyId: number, id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { order: 'asc' } },
        supplier: { select: { id: true, name: true, company: true, email: true, phone: true } },
      },
    });

    if (!invoice) return { error: 'Facture non trouvée' };
    if (invoice.companyId !== companyId) return { error: 'Accès refusé' };

    return {
      ...invoice,
      total: Number(invoice.total),
      amountPaid: Number(invoice.amountPaid),
      remainingAmount: Number(invoice.remainingAmount),
      vatRate: Number(invoice.vatRate),
      subtotal: Number(invoice.subtotal),
      vatAmount: Number(invoice.vatAmount),
      lines: invoice.lines.map((l: any) => ({
        ...l,
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        lineTotal: Number(l.lineTotal),
      })),
    };
  }

  private async createInvoice(userId: number, companyId: number, args: any) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: args.supplierId } });
    if (!supplier) return { error: 'Fournisseur non trouvé' };
    if (supplier.companyId !== companyId) return { error: 'Ce fournisseur ne vous appartient pas' };

    const subtotal = args.lines.reduce((acc: number, l: any) => acc + l.quantity * l.unitPrice, 0);
    let discount = 0;
    if (args.discountType && args.discountValue) {
      discount =
        args.discountType === 'percentage'
          ? (subtotal * args.discountValue) / 100
          : args.discountValue;
    }
    const afterDiscount = Math.max(subtotal - discount, 0);
    const vatAmount = (afterDiscount * args.vatRate) / 100;
    const total = afterDiscount + vatAmount;
    const round = (v: number) => Math.round(v * 100) / 100;

    try {
      const invoice = await this.prisma.invoice.create({
        data: {
          invoiceNumber: args.invoiceNumber,
          status: 'draft',
          dueDate: new Date(args.dueDate),
          vatRate: args.vatRate,
          discountType: args.discountType || null,
          discountValue: args.discountValue || null,
          subtotal: round(subtotal),
          discountAmount: round(discount),
          vatAmount: round(vatAmount),
          total: round(total),
          amountPaid: args.amountPaid ?? 0,
          remainingAmount: round(total - (args.amountPaid ?? 0)),
          notes: args.notes || null,
          supplierId: args.supplierId,
          companyId,
          createdById: userId,
          lines: {
            create: args.lines.map((line: any, index: number) => ({
              description: line.description,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              lineTotal: round(line.quantity * line.unitPrice),
              order: index,
            })),
          },
        },
        include: { lines: true },
      });

      return {
        success: true,
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        total: round(total),
        subtotal: round(subtotal),
        vatAmount: round(vatAmount),
        message: `Facture ${invoice.invoiceNumber} créée avec succès en brouillon (ID: ${invoice.id})`,
      };
    } catch (err: any) {
      if (err.code === 'P2002') {
        return { error: 'Ce numéro de facture existe déjà. Veuillez en choisir un autre.' };
      }
      return { error: 'Erreur lors de la création de la facture' };
    }
  }

  private async getInvoiceAnalytics(companyId: number, args: any) {
    const where: any = { companyId };
    if (args.startDate || args.endDate) {
      where.createdAt = {};
      if (args.startDate) where.createdAt.gte = new Date(args.startDate);
      if (args.endDate) where.createdAt.lte = new Date(args.endDate);
    }

    const [aggregate, countByStatus] = await Promise.all([
      this.prisma.invoice.aggregate({
        where,
        _sum: {
          total: true,
          amountPaid: true,
          remainingAmount: true,
          subtotal: true,
          vatAmount: true,
        },
        _count: { id: true },
      }),
      this.prisma.invoice.groupBy({
        by: ['status'],
        where,
        _count: { id: true },
        _sum: { total: true },
      }),
    ]);

    const round = (v: number) => Math.round(v * 100) / 100;
    const statusMap: Record<string, { count: number; total: number }> = {};
    for (const row of countByStatus) {
      statusMap[row.status] = {
        count: row._count.id,
        total: round(Number(row._sum.total ?? 0)),
      };
    }

    return {
      period: { startDate: args.startDate || 'all time', endDate: args.endDate || 'all time' },
      totalInvoices: aggregate._count.id,
      totalRevenueTTC: round(Number(aggregate._sum.total ?? 0)),
      totalRevenueHT: round(Number(aggregate._sum.subtotal ?? 0)),
      totalTVA: round(Number(aggregate._sum.vatAmount ?? 0)),
      totalPaid: round(Number(aggregate._sum.amountPaid ?? 0)),
      totalRemaining: round(Number(aggregate._sum.remainingAmount ?? 0)),
      byStatus: statusMap,
    };
  }

  private async getDevis(companyId: number, args: any) {
    const { page = 1, limit = 10, status, search } = args;
    const skip = (page - 1) * Math.min(limit, 50);
    const where: any = { companyId };

    if (status) where.status = status;
    if (search?.trim()) {
      where.OR = [
        { supplier: { name: { contains: search.trim(), mode: 'insensitive' } } },
        { supplier: { company: { contains: search.trim(), mode: 'insensitive' } } },
      ];
    }

    const [totalCount, devisList] = await Promise.all([
      this.prisma.devis.count({ where }),
      this.prisma.devis.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(limit, 50),
        select: {
          id: true,
          number: true,
          status: true,
          tvaRate: true,
          validUntil: true,
          amountHT: true,
          amountTVA: true,
          amountTTC: true,
          createdAt: true,
          supplier: { select: { id: true, name: true, company: true } },
        },
      }),
    ]);

    return {
      totalCount,
      page,
      devis: devisList.map((d) => ({
        ...d,
        amountHT: Number(d.amountHT),
        amountTVA: Number(d.amountTVA),
        amountTTC: Number(d.amountTTC),
        tvaRate: Number(d.tvaRate),
      })),
    };
  }

  private async createDevis(userId: number, companyId: number, args: any) {
    const subtotal = args.lines.reduce((acc: number, l: any) => acc + l.quantity * l.unitPrice, 0);
    const vatAmount = (subtotal * args.tvaRate) / 100;
    const total = subtotal + vatAmount;
    const round = (v: number) => Math.round(v * 100) / 100;
    const number = args.number || `DEV-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;

    const devis = await this.prisma.devis.create({
      data: {
        number,
        status: 'en_attente',
        tvaRate: args.tvaRate,
        validUntil: new Date(args.validUntil),
        lines: args.lines,
        notes: args.notes || null,
        amountHT: round(subtotal),
        amountTVA: round(vatAmount),
        amountTTC: round(total),
        ownerId: userId,
        companyId,
        createdBy: userId,
        createdByCompanyId: companyId,
        ...(args.supplierId && { supplierId: args.supplierId }),
      },
    });

    return {
      success: true,
      id: devis.id,
      number: devis.number,
      status: devis.status,
      amountHT: round(subtotal),
      amountTVA: round(vatAmount),
      amountTTC: round(total),
      message: `Devis ${devis.number} créé avec succès (ID: ${devis.id})`,
    };
  }

  private async getSuppliers(companyId: number, args: any) {
    const { page = 1, limit = 20, search } = args;
    const skip = (page - 1) * Math.min(limit, 50);
    const where: any = { companyId };

    if (search?.trim()) {
      where.OR = [
        { name: { contains: search.trim(), mode: 'insensitive' } },
        { company: { contains: search.trim(), mode: 'insensitive' } },
        { email: { contains: search.trim(), mode: 'insensitive' } },
        { taxId: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    const [totalCount, suppliers] = await Promise.all([
      this.prisma.supplier.count({ where }),
      this.prisma.supplier.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(limit, 50),
        select: { id: true, name: true, company: true, email: true, phone: true, taxId: true },
      }),
    ]);

    return { totalCount, suppliers };
  }

  private async getBonsCommande(companyId: number, args: any) {
    const { page = 1, limit = 10, status, search } = args;
    const skip = (page - 1) * Math.min(limit, 50);
    const where: any = { companyId };

    if (status) where.status = status;
    if (search?.trim()) {
      where.OR = [
        { supplier: { name: { contains: search.trim(), mode: 'insensitive' } } },
        { number: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    const [totalCount, bons] = await Promise.all([
      this.prisma.bonCommande.count({ where }),
      this.prisma.bonCommande.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(limit, 50),
        select: {
          id: true,
          number: true,
          status: true,
          amountHT: true,
          amountTVA: true,
          amountTTC: true,
          createdAt: true,
          supplier: { select: { id: true, name: true, company: true } },
        },
      }),
    ]);

    return {
      totalCount,
      bons: bons.map((b) => ({
        ...b,
        amountHT: Number(b.amountHT),
        amountTVA: Number(b.amountTVA),
        amountTTC: Number(b.amountTTC),
      })),
    };
  }

  private calculateTva(args: any) {
    const { tvaRate } = args;
    const round = (v: number) => Math.round(v * 100) / 100;

    if (args.amountHT !== undefined) {
      const amountHT = args.amountHT;
      const tva = (amountHT * tvaRate) / 100;
      return {
        amountHT: round(amountHT),
        tva: round(tva),
        amountTTC: round(amountHT + tva),
        tvaRate,
      };
    }

    if (args.amountTTC !== undefined) {
      const amountTTC = args.amountTTC;
      const amountHT = amountTTC / (1 + tvaRate / 100);
      const tva = amountTTC - amountHT;
      return { amountHT: round(amountHT), tva: round(tva), amountTTC: round(amountTTC), tvaRate };
    }

    return { error: 'Veuillez fournir amountHT ou amountTTC' };
  }

  private async detectAnomalies(companyId: number, args: any) {
    const where: any = { companyId };
    if (args.startDate || args.endDate) {
      where.createdAt = {};
      if (args.startDate) where.createdAt.gte = new Date(args.startDate);
      if (args.endDate) where.createdAt.lte = new Date(args.endDate);
    }

    const invoices = await this.prisma.invoice.findMany({
      where,
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        total: true,
        vatRate: true,
        dueDate: true,
        createdAt: true,
        supplier: { select: { name: true, company: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const anomalies: any[] = [];

    // 1. Duplicate invoice numbers
    const numberCount: Record<string, number[]> = {};
    for (const inv of invoices) {
      if (!numberCount[inv.invoiceNumber]) numberCount[inv.invoiceNumber] = [];
      numberCount[inv.invoiceNumber].push(inv.id);
    }
    for (const [num, ids] of Object.entries(numberCount)) {
      if (ids.length > 1) {
        anomalies.push({
          type: 'DUPLICATE_NUMBER',
          severity: 'HIGH',
          description: `Numéro dupliqué: ${num}`,
          affectedIds: ids,
        });
      }
    }

    // 2. Overdue invoices
    const now = new Date();
    const overdue = invoices.filter(
      (inv) => new Date(inv.dueDate) < now && inv.status !== 'paid' && inv.status !== 'cancelled'
    );
    if (overdue.length > 0) {
      anomalies.push({
        type: 'OVERDUE_INVOICES',
        severity: 'MEDIUM',
        description: `${overdue.length} facture(s) en retard`,
        affectedIds: overdue.map((i) => i.id),
      });
    }

    // 3. Unusual VAT rates
    const standardRates = [0, 7, 13, 19];
    const unusualVat = invoices.filter((inv) => !standardRates.includes(Number(inv.vatRate)));
    if (unusualVat.length > 0) {
      anomalies.push({
        type: 'UNUSUAL_VAT_RATE',
        severity: 'MEDIUM',
        description: `${unusualVat.length} facture(s) avec TVA inhabituelle`,
        affectedIds: unusualVat.map((i) => ({ id: i.id, vatRate: Number(i.vatRate) })),
      });
    }

    // 4. Unusually high amounts
    if (invoices.length > 3) {
      const totals = invoices.map((i) => Number(i.total));
      const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
      const threshold = avg * 3;
      const high = invoices.filter((i) => Number(i.total) > threshold);
      if (high.length > 0) {
        anomalies.push({
          type: 'HIGH_AMOUNT',
          severity: 'LOW',
          description: `${high.length} facture(s) avec montant > 3x la moyenne (${Math.round(avg)} DT)`,
          affectedIds: high.map((i) => ({ id: i.id, total: Number(i.total) })),
        });
      }
    }

    return {
      totalAnalyzed: invoices.length,
      anomaliesFound: anomalies.length,
      anomalies,
      summary:
        anomalies.length === 0
          ? 'Aucune anomalie détectée.'
          : `${anomalies.length} type(s) d'anomalie détecté(s).`,
    };
  }

  // ─── Write Actions ────────────────────────────────────────────────────────────

  private async markInvoicePaid(companyId: number, args: any) {
    const { invoiceId } = args;

    if (!invoiceId || typeof invoiceId !== 'number') {
      return { error: 'invoiceId manquant ou invalide.' };
    }

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        total: true,
        companyId: true,
        supplier: { select: { name: true } },
      },
    });

    if (!invoice) return { error: `Facture ID ${invoiceId} introuvable.` };
    if (invoice.companyId !== companyId) return { error: 'Accès refusé.' };
    if (invoice.status === 'paid') {
      return { error: `La facture ${invoice.invoiceNumber} est déjà marquée comme payée.` };
    }
    if (invoice.status === 'cancelled') {
      return {
        error: `La facture ${invoice.invoiceNumber} est annulée — impossible de la marquer payée.`,
      };
    }

    const total = Number(invoice.total);
    const round = (v: number) => Math.round(v * 100) / 100;

    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'paid', amountPaid: round(total), remainingAmount: 0 },
    });

    return {
      success: true,
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      supplier: invoice.supplier?.name ?? null,
      status: 'paid',
      total: round(total),
      message: `Facture ${invoice.invoiceNumber} marquée comme payée (${round(total)} DT).`,
    };
  }

  private async createTask(userId: number, companyId: number, args: any) {
    const { title, description, type = 'other', priority = 'medium', dueDate } = args;

    if (!title?.trim()) return { error: 'Le titre de la tâche est obligatoire.' };

    const VALID_TYPES = ['accounting', 'review', 'meeting', 'document', 'other'];
    const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
    if (!VALID_TYPES.includes(type)) return { error: `Type invalide: ${type}` };
    if (!VALID_PRIORITIES.includes(priority)) return { error: `Priorité invalide: ${priority}` };

    let parsedDue: Date | null = null;
    if (dueDate) {
      parsedDue = new Date(dueDate);
      if (isNaN(parsedDue.getTime())) return { error: `Date invalide: ${dueDate}` };
    }

    const task = await this.prisma.task.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        type,
        priority,
        status: 'todo',
        dueDate: parsedDue,
        createdById: userId,
        companyId,
        subtasks: [],
        attachments: [],
      },
      select: { id: true, title: true, type: true, priority: true, status: true, dueDate: true },
    });

    return {
      success: true,
      id: task.id,
      title: task.title,
      type: task.type,
      priority: task.priority,
      status: task.status,
      dueDate: task.dueDate,
      message: `Tâche "${task.title}" créée avec succès (ID: ${task.id}, priorité: ${task.priority}).`,
    };
  }

  private async createAppointment(userId: number, companyId: number, args: any) {
    const {
      title,
      date,
      hour,
      type = 'meeting',
      meetingType = 'in_person',
      description,
      location,
    } = args;

    if (!title?.trim()) return { error: 'Le titre du rendez-vous est obligatoire.' };
    if (!date) return { error: 'La date est obligatoire.' };
    if (!hour) return { error: "L'heure est obligatoire." };

    const parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
      return { error: `Format de date invalide: "${date}". Utilisez YYYY-MM-DD.` };
    }
    if (!/^\d{2}:\d{2}$/.test(hour)) {
      return { error: `Format d'heure invalide: "${hour}". Utilisez HH:mm (ex: 14:00).` };
    }

    const VALID_TYPES = ['meeting', 'consultation', 'review', 'other'];
    const VALID_MEETING_TYPES = ['in_person', 'online', 'phone'];
    if (!VALID_TYPES.includes(type)) return { error: `Type invalide: ${type}` };
    if (!VALID_MEETING_TYPES.includes(meetingType))
      return { error: `Format de réunion invalide: ${meetingType}` };

    const appointment = await this.prisma.appointment.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        type,
        date: parsedDate,
        hour,
        status: 'pending',
        meetingType,
        location: location?.trim() || null,
        clientId: userId,
        companyId,
      },
      select: {
        id: true,
        title: true,
        date: true,
        hour: true,
        type: true,
        status: true,
        meetingType: true,
      },
    });

    return {
      success: true,
      id: appointment.id,
      title: appointment.title,
      date: appointment.date,
      hour: appointment.hour,
      type: appointment.type,
      meetingType: appointment.meetingType,
      status: 'pending',
      message: `Rendez-vous "${appointment.title}" créé pour le ${date} à ${hour} (ID: ${appointment.id}).`,
    };
  }

  private async getFinancialSummary(companyId: number) {
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const round = (v: number) => Math.round(v * 100) / 100;

    const [byStatus, paidThisMonth, topOverdue, insights] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['status'],
        where: { companyId },
        _count: { id: true },
        _sum: { total: true, remainingAmount: true },
      }),
      this.prisma.invoice.aggregate({
        where: {
          companyId,
          status: 'paid',
          updatedAt: { gte: firstOfMonth, lte: lastOfMonth },
        },
        _sum: { total: true },
        _count: { id: true },
      }),
      this.prisma.invoice.findMany({
        where: {
          companyId,
          status: { in: ['sent', 'partial', 'overdue'] },
          dueDate: { lt: now },
        },
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          dueDate: true,
          supplier: { select: { name: true } },
        },
        take: 5,
        orderBy: { dueDate: 'asc' },
      }),
      this.aiInsightsService.getInsights(companyId),
    ]);

    const statusMap: Record<string, { count: number; total: number }> = {};
    let totalUnpaid = 0;
    let countUnpaid = 0;

    for (const row of byStatus) {
      statusMap[row.status] = {
        count: row._count.id,
        total: round(Number(row._sum.total ?? 0)),
      };
      if (!['paid', 'cancelled', 'draft'].includes(row.status)) {
        totalUnpaid += Number(row._sum.remainingAmount ?? 0);
        countUnpaid += row._count.id;
      }
    }

    // Format insights summary for the LLM
    const insightsSummary =
      insights.length > 0
        ? insights
            .map((i) => `[${i.severity.toUpperCase()}] ${i.title}: ${i.description}`)
            .join('\n')
        : 'Aucune alerte active.';

    return {
      paidThisMonth: {
        count: paidThisMonth._count.id,
        total: round(Number(paidThisMonth._sum.total ?? 0)),
      },
      unpaid: { count: countUnpaid, total: round(totalUnpaid) },
      overdue: {
        count: topOverdue.length,
        invoices: topOverdue.map((i) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          total: round(Number(i.total)),
          dueDate: i.dueDate,
          supplier: i.supplier?.name ?? null,
        })),
      },
      byStatus: statusMap,
      aiInsights: {
        count: insights.length,
        criticalCount: insights.filter((i) => i.severity === 'critical').length,
        warningCount: insights.filter((i) => i.severity === 'warning').length,
        summary: insightsSummary,
      },
    };
  }
}
