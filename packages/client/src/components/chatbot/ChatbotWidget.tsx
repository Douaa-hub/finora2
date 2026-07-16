// rewriting

import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { useLocation } from "react-router-dom";
import {
  Box,
  Button,
  Fab,
  Paper,
  Typography,
  TextField,
  InputAdornment,
  IconButton,
  Avatar,
  Chip,
  Collapse,
  Fade,
  Tooltip,
  alpha,
  useTheme,
  useMediaQuery,
  Skeleton,
  Badge,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import {
  MessageCircle,
  X,
  Bot,
  User,
  Trash2,
  Minimize2,
  Maximize2,
  Plus,
  History,
  Pencil,
  Check,
  ArrowLeft,
  MessageSquare,
  FileText,
  BarChart3,
  Calculator,
  AlertTriangle,
  Building2,
  Package,
  TrendingUp,
  CheckCircle,
  XCircle,
  Zap,
  Search,
  Play,
  Pause,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ChatAttachment } from "src/lib/services/chatbotApi";
import {
  chatbotApi,
  useSendMessageMutation,
  useGetSessionsQuery,
  useGetSessionQuery,
  useRenameSessionMutation,
  useDeleteSessionMutation,
  useGetInsightsQuery,
  useUploadAttachmentMutation,
} from "src/lib/services/chatbotApi";
import { invoicesApi } from "src/lib/services/invoicesApi";
import { factureApi } from "src/lib/services/factureApi";
import { tasksApi } from "src/lib/services/tasksApi";
import { appointmentsApi } from "src/lib/services/appointmentsApi";
import { devisApi } from "src/lib/services/devisApi";
import { useAppDispatch, useAppSelector } from "src/hooks/use-redux";
import { ROLE_CODES } from "src/constants/roles";
import { InsightsPanel } from "./InsightsPanel";
import { ChatInputBar } from "./ChatInputBar";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Configure pdf.js worker once at module load — required before any getDocument call
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─── Constants ────────────────────────────────────────────────────────────────

const SUGGESTED_PROMPTS = [
  {
    label: "Factures impayées",
    icon: <FileText size={11} />,
    prompt: "Afficher mes factures impayées",
  },
  {
    label: "Chiffre d'affaires",
    icon: <BarChart3 size={11} />,
    prompt: "Analyser mon chiffre d'affaires",
  },
  {
    label: "Créer une facture",
    icon: <Plus size={11} />,
    prompt: "Créer une nouvelle facture",
  },
  {
    label: "Anomalies comptables",
    icon: <AlertTriangle size={11} />,
    prompt: "Vérifier les anomalies comptables",
  },
];

const TOOL_LABELS: Record<string, { label: string; icon: React.ReactNode }> = {
  get_invoices: { label: "Factures", icon: <FileText size={12} /> },
  get_invoice_by_id: { label: "Détail facture", icon: <FileText size={12} /> },
  create_invoice: { label: "Création facture", icon: <Plus size={12} /> },
  get_invoice_analytics: {
    label: "Analytiques",
    icon: <BarChart3 size={12} />,
  },
  get_devis: { label: "Devis", icon: <FileText size={12} /> },
  create_devis: { label: "Création devis", icon: <Plus size={12} /> },
  get_suppliers: { label: "Fournisseurs", icon: <Building2 size={12} /> },
  get_bons_commande: { label: "Bons de commande", icon: <Package size={12} /> },
  calculate_tva: { label: "Calcul TVA", icon: <Calculator size={12} /> },
  detect_anomalies: { label: "Anomalies", icon: <AlertTriangle size={12} /> },
  mark_invoice_paid: { label: "Paiement facture", icon: <Check size={12} /> },
  create_task: { label: "Nouvelle tâche", icon: <Plus size={12} /> },
  create_appointment: { label: "Nouveau RDV", icon: <Plus size={12} /> },
  get_financial_summary: {
    label: "Résumé financier",
    icon: <TrendingUp size={12} />,
  },
};

function formatRelativeDate(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  // Normalize both to local midnight so 23:50 yesterday ≠ today
  const dateDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const todayDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const diffDays = Math.round((todayDay - dateDay) / 86400000);
  if (diffDays === 0) return "Aujourd'hui";
  if (diffDays === 1) return "Hier";
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ─── Shared gradient header ───────────────────────────────────────────────────

function GradientHeader({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        px: 2.5,
        py: 2,
        flexShrink: 0,
        background:
          "linear-gradient(135deg, #0a2251 0%, #1d61e7 58%, #1649ad 100%)",
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        boxShadow: "0 4px 20px rgba(29,97,231,0.32)",
      }}
    >
      {children}
    </Box>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract "m:ss" duration embedded in content like "[Message vocal : 0:03]" */
function parseVoiceDuration(content: string): string | null {
  const m = content.match(/Message vocal\s*:\s*(\d+:\d+)/);
  return m ? m[1] : null;
}

// ─── Audio Message Bubble ─────────────────────────────────────────────────────

// 40 bars — natural voice pattern, heights purely decorative
const WAVE_BARS: number[] = [
  3, 6, 8, 5, 10, 7, 12, 9, 6, 11, 4, 8, 13, 7, 5, 10, 8, 12, 6, 9, 4, 11, 7,
  13, 5, 8, 10, 6, 12, 4, 9, 7, 11, 5, 8, 13, 6, 10, 7, 4,
];

function AudioMessageBubble({
  url,
  parsedDuration,
  transcription,
  isUser,
}: {
  url: string;
  parsedDuration: string | null;
  transcription?: string | null;
  isUser: boolean;
}) {
  const theme = useTheme();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);

  const parsedDurationSec: number | null = (() => {
    if (!parsedDuration) return null;
    const [a, b] = parsedDuration.split(":");
    const mm = parseInt(a, 10),
      ss = parseInt(b, 10);
    return isNaN(mm) || isNaN(ss) ? null : mm * 60 + ss;
  })();

  const duration = audioDuration ?? parsedDurationSec ?? 0;
  const progress =
    duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    setCurrentTime(a.currentTime);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.src = url;
    audioRef.current = audio;

    const onDur = () => {
      const d = audio.duration;
      if (!isNaN(d) && d > 0 && d !== Infinity) setAudioDuration(d);
    };
    const onEnd = () => {
      stopRaf();
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener("loadedmetadata", onDur);
    audio.addEventListener("durationchange", onDur);
    audio.addEventListener("ended", onEnd);
    return () => {
      stopRaf();
      audio.removeEventListener("loadedmetadata", onDur);
      audio.removeEventListener("durationchange", onDur);
      audio.removeEventListener("ended", onEnd);
      audio.pause();
      audio.src = "";
    };
  }, [url, stopRaf]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying) {
      a.pause();
      stopRaf();
      setIsPlaying(false);
    } else {
      void a
        .play()
        .then(() => {
          setIsPlaying(true);
          rafRef.current = requestAnimationFrame(tick);
        })
        .catch((err: unknown) => {
          console.error("[AudioBubble]", err);
          setIsPlaying(false);
        });
    }
  };

  const handleSeek = (e: React.MouseEvent) => {
    const a = audioRef.current;
    const el = trackRef.current;
    if (!a || !el || duration <= 0) return;
    const { left, width } = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - left) / width));
    const newTime = ratio * duration;
    a.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const displayTime = isPlaying
    ? fmt(currentTime)
    : (parsedDuration ??
      (audioDuration !== null ? fmt(audioDuration) : "0:00"));

  const barInactive = isUser
    ? "rgba(255,255,255,0.40)"
    : alpha(theme.palette.primary.main, 0.22);
  const barActive = isUser
    ? "rgba(255,255,255,0.92)"
    : theme.palette.primary.main;
  const dotBg = isUser ? "#fff" : theme.palette.primary.main;
  const dotRing = isUser
    ? "rgba(255,255,255,0.28)"
    : alpha(theme.palette.primary.main, 0.22);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        maxWidth: 300,
        minWidth: 220,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          px: "14px",
          py: "10px",
          borderRadius: isUser ? "16px 16px 2px 16px" : "16px 16px 16px 2px",
          bgcolor: isUser
            ? theme.palette.primary.main
            : theme.palette.background.paper,
          boxShadow: isUser
            ? `0 2px 8px ${alpha(theme.palette.primary.main, 0.25)}`
            : `0 1px 4px ${alpha(theme.palette.common.black, 0.06)}`,
          border: isUser
            ? "none"
            : `1px solid ${alpha(theme.palette.divider, 0.4)}`,
        }}
      >
        {/* ── Play / Pause ── */}
        <IconButton
          size="small"
          onClick={togglePlay}
          sx={{
            width: 40,
            height: 40,
            flexShrink: 0,
            bgcolor: isUser
              ? "rgba(255,255,255,0.2)"
              : alpha(theme.palette.primary.main, 0.1),
            color: isUser ? "#fff" : theme.palette.primary.main,
            "&:hover": {
              bgcolor: isUser
                ? "rgba(255,255,255,0.32)"
                : alpha(theme.palette.primary.main, 0.18),
            },
          }}
        >
          {isPlaying ? (
            <Pause size={17} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={17} fill="currentColor" strokeWidth={0} />
          )}
        </IconButton>

        {/* ── Waveform column ── */}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: "5px",
          }}
        >
          {/*
            Track: flex + position:relative.
            Bars fill 100% width via flex:1.
            Dot is absolute in the same space.
            No overflow:hidden — dot left uses radius offset so it never clips.
              progress=0 → left=DOT_RADIUS     (dot left-edge flush with track left)
              progress=1 → left=100%-DOT_RADIUS (dot right-edge flush with track right)
          */}
          <Box
            ref={trackRef as React.RefObject<HTMLDivElement>}
            onClick={handleSeek}
            sx={{
              position: "relative",
              width: "100%",
              height: 28,
              display: "flex",
              alignItems: "center",
              gap: "2px",
              cursor: duration > 0 ? "pointer" : "default",
              userSelect: "none",
            }}
          >
            {WAVE_BARS.map((h, i) => (
              <Box
                key={i}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  height: `${h}px`,
                  borderRadius: "2px",
                  bgcolor:
                    i / WAVE_BARS.length < progress ? barActive : barInactive,
                  transition: "background-color 0.04s",
                }}
              />
            ))}

            {/* Dot: left = DOT_RADIUS + progress*(100% - DOT_SIZE) keeps center in [r, 100%-r] */}
            <Box
              sx={{
                position: "absolute",
                top: "50%",
                left: `calc(5.5px + ${(progress * 100).toFixed(3)}% - ${(progress * 11).toFixed(3)}px)`,
                transform: "translate(-50%, -50%)",
                width: 11,
                height: 11,
                borderRadius: "50%",
                bgcolor: dotBg,
                boxShadow: `0 0 0 3px ${dotRing}`,
                pointerEvents: "none",
                zIndex: 1,
              }}
            />
          </Box>

          {/* Duration */}
          <Typography
            variant="caption"
            sx={{
              fontSize: "0.69rem",
              lineHeight: 1,
              color: isUser ? "rgba(255,255,255,0.85)" : "text.secondary",
            }}
          >
            {displayTime}
          </Typography>
        </Box>
      </Box>

      {transcription && (
        <Typography
          variant="caption"
          sx={{
            color: isUser ? "rgba(255,255,255,0.65)" : "text.secondary",
            fontSize: "0.68rem",
            fontStyle: "italic",
            pl: 0.25,
          }}
        >
          Transcription : {transcription}
        </Typography>
      )}
    </Box>
  );
}

// ─── PDF attachment helpers ───────────────────────────────────────────────────

/** Remove "[Fichier joint : ...]" / "[Image jointe : ...]" mention lines injected by ChatInputBar */
function stripAttachmentMention(content: string): string {
  return content
    .split("\n")
    .filter(
      (line) => !/^\[(?:Fichier joint|Image jointe)\s*:/i.test(line.trim()),
    )
    .join("\n")
    .trim();
}

function isPdf(att: ChatAttachment): boolean {
  return (
    att.mimeType.includes("pdf") || att.name.toLowerCase().endsWith(".pdf")
  );
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

// ─── PDF thumbnail hook ───────────────────────────────────────────────────────

interface PdfThumbnailState {
  dataUrl: string | null;
  pageCount: number | null;
  loading: boolean;
  error: boolean;
}

function usePdfThumbnail(url: string | undefined): PdfThumbnailState {
  const [state, setState] = useState<PdfThumbnailState>({
    dataUrl: null,
    pageCount: null,
    loading: !!url,
    error: false,
  });

  useEffect(() => {
    // Always declare cancelled so the single return () => {} can always reset it.
    let cancelled = false;

    if (!url) {
      setState({
        dataUrl: null,
        pageCount: null,
        loading: false,
        error: false,
      });
    } else {
      setState({ dataUrl: null, pageCount: null, loading: true, error: false });

      (async () => {
        try {
          const loadingTask = pdfjsLib.getDocument({
            url,
            withCredentials: false,
          });
          const doc = await loadingTask.promise;
          if (cancelled) {
            doc.destroy();
            return;
          }

          const pageCount = doc.numPages;
          const page = await doc.getPage(1);
          if (cancelled) {
            doc.destroy();
            return;
          }

          const viewport = page.getViewport({ scale: 1 });
          const scale = 280 / viewport.width;
          const sv = page.getViewport({ scale });

          const canvas = document.createElement("canvas");
          canvas.width = Math.round(sv.width);
          canvas.height = Math.round(sv.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("no 2d context");

          await page.render({ canvas, canvasContext: ctx, viewport: sv })
            .promise;
          if (cancelled) {
            doc.destroy();
            return;
          }

          const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
          doc.destroy();

          if (!cancelled)
            setState({ dataUrl, pageCount, loading: false, error: false });
        } catch {
          if (!cancelled)
            setState({
              dataUrl: null,
              pageCount: null,
              loading: false,
              error: true,
            });
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}

// ─── PDF Preview Card ─────────────────────────────────────────────────────────

function PdfCard({ attachment }: { attachment: ChatAttachment }) {
  const theme = useTheme();
  const { dataUrl, pageCount, loading } = usePdfThumbnail(
    attachment.url || undefined,
  );

  return (
    <Box
      component="a"
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      sx={{
        display: "block",
        width: 260,
        maxWidth: "100%",
        borderRadius: "14px",
        overflow: "hidden",
        border: `1.5px solid ${alpha(theme.palette.divider, 0.55)}`,
        textDecoration: "none",
        cursor: "pointer",
        bgcolor: "background.paper",
        boxShadow: `0 2px 10px ${alpha(theme.palette.common.black, 0.07)}`,
        transition: "box-shadow 0.18s, transform 0.18s",
        "&:hover": {
          boxShadow: `0 6px 24px ${alpha(theme.palette.common.black, 0.14)}`,
          transform: "translateY(-2px)",
        },
      }}
    >
      {/* ── Thumbnail area ── */}
      <Box
        sx={{
          position: "relative",
          width: "100%",
          height: 175,
          bgcolor: alpha(theme.palette.grey[200], 0.7),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {loading && (
          <Skeleton
            variant="rectangular"
            width="100%"
            height="100%"
            sx={{ transform: "none" }}
          />
        )}
        {!loading && dataUrl && (
          <Box
            component="img"
            src={dataUrl}
            alt="Aperçu PDF"
            sx={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "top center",
              display: "block",
            }}
          />
        )}
        {!loading && !dataUrl && (
          <Box sx={{ textAlign: "center", py: 2, px: 1 }}>
            <FileText size={44} color={alpha(theme.palette.error.main, 0.55)} />
            <Typography
              variant="caption"
              sx={{ display: "block", color: "text.disabled", mt: 0.5 }}
            >
              Aperçu indisponible
            </Typography>
          </Box>
        )}

        {/* Red PDF badge pinned top-right */}
        <Box
          sx={{
            position: "absolute",
            top: 8,
            right: 8,
            bgcolor: theme.palette.error.main,
            borderRadius: "5px",
            px: 0.75,
            py: 0.2,
            lineHeight: 1,
          }}
        >
          <Typography
            component="span"
            sx={{
              fontSize: "0.46rem",
              fontWeight: 900,
              letterSpacing: "0.08em",
              color: "#fff",
            }}
          >
            PDF
          </Typography>
        </Box>
      </Box>

      {/* ── Info bar ── */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          px: 1.5,
          py: 1.25,
          bgcolor: "background.paper",
          borderTop: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
        }}
      >
        <Box
          sx={{
            width: 36,
            height: 36,
            flexShrink: 0,
            borderRadius: 1.25,
            bgcolor: alpha(theme.palette.error.main, 0.1),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FileText size={18} color={theme.palette.error.main} />
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            sx={{
              fontWeight: 600,
              fontSize: "0.8rem",
              color: "text.primary",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              lineHeight: 1.3,
            }}
          >
            {attachment.name}
          </Typography>
          <Typography
            sx={{
              fontSize: "0.69rem",
              color: "text.secondary",
              lineHeight: 1.3,
            }}
          >
            {[
              fmtBytes(attachment.size),
              pageCount != null
                ? `${pageCount} page${pageCount > 1 ? "s" : ""}`
                : null,
              "PDF",
            ]
              .filter(Boolean)
              .join(" · ")}
          </Typography>
        </Box>

        <Typography
          sx={{
            flexShrink: 0,
            fontSize: "0.7rem",
            fontWeight: 700,
            color: "primary.main",
          }}
        >
          Ouvrir
        </Typography>
      </Box>
    </Box>
  );
}

// ─── Welcome Card ─────────────────────────────────────────────────────────────

function WelcomeCard() {
  const theme = useTheme();
  return (
    <Fade in timeout={400}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, mb: 1.5 }}>
        <Avatar
          sx={{
            width: 32,
            height: 32,
            flexShrink: 0,
            bgcolor: alpha(theme.palette.secondary.main, 0.1),
            color: theme.palette.secondary.main,
            border: `2px solid ${alpha(theme.palette.secondary.main, 0.18)}`,
          }}
        >
          <Bot size={16} />
        </Avatar>

        <Box sx={{ maxWidth: "86%", minWidth: 0 }}>
          <Box
            sx={{
              px: 2,
              py: 1.75,
              borderRadius: "16px 16px 16px 2px",
              bgcolor: theme.palette.background.paper,
              border: `1px solid ${alpha(theme.palette.divider, 0.4)}`,
              boxShadow: `0 1px 4px ${alpha(theme.palette.common.black, 0.06)}`,
            }}
          >
            <Typography
              variant="body2"
              fontWeight={600}
              sx={{ fontSize: "0.875rem", mb: 0.5 }}
            >
              Bonjour, je suis votre assistant Finora.
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontSize: "0.82rem", lineHeight: 1.6, mb: 1.5 }}
            >
              Je peux vous aider à gérer vos finances et analyser vos données
              comptables.
            </Typography>

            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.9 }}>
              <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
                <FileText
                  size={13}
                  color={theme.palette.primary.main}
                  style={{ marginTop: 1, flexShrink: 0 }}
                />
                <Typography
                  variant="caption"
                  sx={{
                    fontSize: "0.78rem",
                    lineHeight: 1.55,
                    color: "text.secondary",
                  }}
                >
                  <Box
                    component="span"
                    sx={{ fontWeight: 600, color: "text.primary" }}
                  >
                    Facturation & devis
                  </Box>
                  {" — fournisseurs, bons de commande"}
                </Typography>
              </Box>
              <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
                <BarChart3
                  size={13}
                  color={theme.palette.secondary.main}
                  style={{ marginTop: 1, flexShrink: 0 }}
                />
                <Typography
                  variant="caption"
                  sx={{
                    fontSize: "0.78rem",
                    lineHeight: 1.55,
                    color: "text.secondary",
                  }}
                >
                  <Box
                    component="span"
                    sx={{ fontWeight: 600, color: "text.primary" }}
                  >
                    Analyses & TVA
                  </Box>
                  {" — chiffre d'affaires, anomalies"}
                </Typography>
              </Box>
            </Box>
          </Box>

          <Typography
            variant="caption"
            sx={{
              display: "block",
              mt: 0.5,
              color: "text.disabled",
              fontSize: "0.7rem",
              pl: 0.5,
            }}
          >
            {new Date().toLocaleTimeString("fr-FR", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Typography>
        </Box>
      </Box>
    </Fade>
  );
}

// ─── Assistant Markdown Renderer ──────────────────────────────────────────────

function extractNodeText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node))
    return (node as unknown[]).map(extractNodeText).join("");
  if (typeof node === "object") {
    const el = node as { props?: { children?: unknown } };
    if (el.props !== undefined) return extractNodeText(el.props.children);
  }
  return "";
}

const STATUS_COLORS: Array<{ pattern: RegExp; color: string }> = [
  { pattern: /^payé$|^réglé$|^paid$/i, color: "#059669" },
  { pattern: /^impayé$|^non payé$|^overdue$/i, color: "#DC2626" },
  { pattern: /^en retard$/i, color: "#D97706" },
  { pattern: /^partiel$|^partiellement payé$|^partial$/i, color: "#D97706" },
  { pattern: /^en attente$|^pending$/i, color: "#F59E0B" },
  { pattern: /^annulé$|^annulée$|^cancelled$/i, color: "#6B7280" },
  { pattern: /^brouillon$|^draft$/i, color: "#7C3AED" },
  { pattern: /^envoyé$|^envoyée$|^sent$/i, color: "#3B82F6" },
  { pattern: /^validé$|^validée$|^approved$/i, color: "#059669" },
];

function getStatusColor(text: string): string | null {
  const t = text.trim();
  for (const { pattern, color } of STATUS_COLORS) {
    if (pattern.test(t)) return color;
  }
  return null;
}

function AssistantMarkdown({ content }: { content: string }) {
  const theme = useTheme();

  const tableComponents = useMemo(
    () => ({
      table: ({ children }: { children?: React.ReactNode }) => (
        <Box
          sx={{
            overflowX: "auto",
            my: 1.5,
            borderRadius: "10px",
            border: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
            boxShadow: `0 1px 6px ${alpha(theme.palette.common.black, 0.05)}`,
          }}
        >
          <Box
            component="table"
            sx={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.76rem",
            }}
          >
            {children}
          </Box>
        </Box>
      ),
      thead: ({ children }: { children?: React.ReactNode }) => (
        <Box
          component="thead"
          sx={{ background: alpha(theme.palette.primary.main, 0.07) }}
        >
          {children}
        </Box>
      ),
      tbody: ({ children }: { children?: React.ReactNode }) => (
        <tbody>{children}</tbody>
      ),
      tr: ({ children }: { children?: React.ReactNode }) => (
        <Box
          component="tr"
          sx={{
            borderBottom: `1px solid ${alpha(theme.palette.divider, 0.3)}`,
          }}
        >
          {children}
        </Box>
      ),
      th: ({ children }: { children?: React.ReactNode }) => (
        <Box
          component="th"
          sx={{
            padding: "8px 12px",
            fontWeight: 700,
            fontSize: "0.7rem",
            textAlign: "left",
            borderBottom: `2px solid ${alpha(theme.palette.primary.main, 0.22)}`,
            whiteSpace: "nowrap",
            color: theme.palette.text.primary,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {children}
        </Box>
      ),
      td: ({ children }: { children?: React.ReactNode }) => {
        const text = extractNodeText(children);
        const statusColor = getStatusColor(text);
        return (
          <Box
            component="td"
            sx={{
              padding: "7px 12px",
              verticalAlign: "middle",
              color: theme.palette.text.secondary,
              whiteSpace: "nowrap",
            }}
          >
            {statusColor ? (
              <Box
                component="span"
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  px: 0.75,
                  py: 0.2,
                  borderRadius: "6px",
                  bgcolor: alpha(statusColor, 0.1),
                  color: statusColor,
                  fontSize: "0.68rem",
                  fontWeight: 700,
                  border: `1px solid ${alpha(statusColor, 0.25)}`,
                }}
              >
                {text}
              </Box>
            ) : (
              children
            )}
          </Box>
        );
      },
    }),
    [theme],
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={tableComponents as any}
    >
      {content}
    </ReactMarkdown>
  );
}

// ─── Message Bubble ───────────────────────────────────────────────────────────

const MessageBubble = memo(function MessageBubble({
  msg,
}: {
  msg: ChatMessage;
}) {
  const theme = useTheme();
  const isUser = msg.role === "user";
  const ts =
    msg.timestamp ??
    (msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now());

  const isAudioMessage =
    isUser && !!msg.attachment?.mimeType.startsWith("audio/");
  const voiceDuration = isAudioMessage ? parseVoiceDuration(msg.content) : null;
  // Strip "[Fichier joint: ...]" / "[Image jointe: ...]" lines so the text bubble
  // shows only actual user-typed text. Empty when user attached with no message.
  const displayText =
    isUser && !isAudioMessage
      ? stripAttachmentMention(msg.content)
      : msg.content;

  return (
    <Fade in timeout={300}>
      <Box
        sx={{
          display: "flex",
          flexDirection: isUser ? "row-reverse" : "row",
          alignItems: "flex-start",
          gap: isUser ? 2 : 1,
          mb: 1.5,
        }}
      >
        <Avatar
          sx={{
            width: 32,
            height: 32,
            flexShrink: 0,
            bgcolor: isUser
              ? theme.palette.primary.main
              : alpha(theme.palette.secondary.main, 0.12),
            color: isUser ? "#fff" : theme.palette.secondary.main,
            border: isUser
              ? "none"
              : `2px solid ${alpha(theme.palette.secondary.main, 0.2)}`,
          }}
        >
          {isUser ? <User size={16} /> : <Bot size={16} />}
        </Avatar>

        <Box
          sx={{
            maxWidth: isUser ? "calc(100% - 48px)" : "75%",
            minWidth: 0,
            flexShrink: 1,
          }}
        >
          {isAudioMessage ? (
            <AudioMessageBubble
              url={msg.attachment!.url}
              parsedDuration={voiceDuration}
              transcription={msg.transcription}
              isUser={isUser}
            />
          ) : (
            <>
              {(displayText || !isUser) && (
                <Box
                  sx={{
                    px: 2,
                    py: 1.5,
                    borderRadius: isUser
                      ? "16px 16px 2px 16px"
                      : "16px 16px 16px 2px",
                    bgcolor: isUser
                      ? theme.palette.primary.main
                      : theme.palette.background.paper,
                    color: isUser ? "#fff" : "text.primary",
                    boxShadow: isUser
                      ? `0 2px 8px ${alpha(theme.palette.primary.main, 0.25)}`
                      : `0 1px 4px ${alpha(theme.palette.common.black, 0.06)}`,
                    border: isUser
                      ? "none"
                      : `1px solid ${alpha(theme.palette.divider, 0.4)}`,
                    "& p": { margin: 0, lineHeight: 1.6, fontSize: "0.875rem" },
                    "& ul, & ol": { pl: 2.5, my: 0.75 },
                    "& li": { fontSize: "0.875rem", lineHeight: 1.6, mb: 0.5 },
                    "& strong": { fontWeight: 600 },
                    "& h1, & h2, & h3, & h4": {
                      fontSize: "0.95rem",
                      fontWeight: 600,
                      mt: 1,
                      mb: 0.5,
                    },
                    "& code": {
                      bgcolor: alpha(
                        theme.palette.common.black,
                        isUser ? 0.15 : 0.05,
                      ),
                      px: 0.75,
                      py: 0.25,
                      borderRadius: 1,
                      fontSize: "0.8rem",
                      fontFamily: "monospace",
                    },
                  }}
                >
                  {isUser ? (
                    <Typography variant="body2" sx={{ lineHeight: 1.55 }}>
                      {displayText}
                    </Typography>
                  ) : (
                    <AssistantMarkdown content={msg.content} />
                  )}
                </Box>
              )}

              {/* ── Image / document / PDF attachment ──────────────────────── */}
              {isUser && msg.attachment && (
                <Box sx={{ mt: displayText ? 0.75 : 0 }}>
                  {msg.attachment.mimeType.startsWith("image/") ? (
                    <Box
                      component="img"
                      src={msg.attachment.url}
                      alt={msg.attachment.name}
                      sx={{
                        display: "block",
                        maxWidth: 180,
                        maxHeight: 140,
                        borderRadius: 1.5,
                        objectFit: "cover",
                        cursor: "pointer",
                        border: `2px solid rgba(255,255,255,0.25)`,
                      }}
                      onClick={() => window.open(msg.attachment!.url, "_blank")}
                    />
                  ) : isPdf(msg.attachment) ? (
                    <PdfCard attachment={msg.attachment} />
                  ) : (
                    <Box
                      component="a"
                      href={msg.attachment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 0.75,
                        bgcolor: "rgba(255,255,255,0.15)",
                        borderRadius: 1.5,
                        px: 1.25,
                        py: 0.75,
                        textDecoration: "none",
                        color: "#fff",
                        maxWidth: 240,
                        "&:hover": { bgcolor: "rgba(255,255,255,0.25)" },
                      }}
                    >
                      <FileText size={14} style={{ flexShrink: 0 }} />
                      <Typography
                        variant="caption"
                        sx={{
                          fontSize: "0.72rem",
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {msg.attachment.name}
                      </Typography>
                    </Box>
                  )}
                </Box>
              )}
            </>
          )}

          {!isUser && msg.toolsUsed && msg.toolsUsed.length > 0 && (
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                gap: 0.5,
                mt: 0.75,
                pl: 0.5,
              }}
            >
              {msg.toolsUsed.map((tool) => {
                const toolInfo = TOOL_LABELS[tool] ?? {
                  label: tool,
                  icon: null,
                };
                return (
                  <Chip
                    key={tool}
                    icon={toolInfo.icon as any}
                    label={toolInfo.label}
                    size="small"
                    sx={{
                      height: 22,
                      fontSize: "0.7rem",
                      bgcolor: alpha(theme.palette.primary.main, 0.08),
                      color: theme.palette.primary.main,
                      border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
                      "& .MuiChip-label": { px: 1 },
                      "& .MuiChip-icon": {
                        color: theme.palette.primary.main,
                        ml: 0.75,
                      },
                    }}
                  />
                );
              })}
            </Box>
          )}

          <Typography
            variant="caption"
            sx={{
              display: "block",
              mt: 0.5,
              color: "text.disabled",
              fontSize: "0.7rem",
              textAlign: isUser ? "right" : "left",
              px: 0.5,
            }}
          >
            {new Date(ts).toLocaleTimeString("fr-FR", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Typography>
        </Box>
      </Box>
    </Fade>
  );
});

function TypingIndicator() {
  const theme = useTheme();
  return (
    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, mb: 1.5 }}>
      <Avatar
        sx={{
          width: 32,
          height: 32,
          bgcolor: alpha(theme.palette.secondary.main, 0.12),
          color: theme.palette.secondary.main,
          border: `2px solid ${alpha(theme.palette.secondary.main, 0.2)}`,
        }}
      >
        <Bot size={16} />
      </Avatar>
      <Box
        sx={{
          px: 2.5,
          py: 1.75,
          borderRadius: "16px 16px 16px 2px",
          bgcolor: theme.palette.background.paper,
          border: `1px solid ${alpha(theme.palette.divider, 0.4)}`,
          boxShadow: `0 1px 4px ${alpha(theme.palette.common.black, 0.06)}`,
          display: "flex",
          alignItems: "center",
          gap: 0.6,
        }}
      >
        {[0, 1, 2].map((i) => (
          <Box
            key={i}
            sx={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              bgcolor: theme.palette.primary.main,
              animation: "bounce 1.4s infinite",
              animationDelay: `${i * 0.2}s`,
              "@keyframes bounce": {
                "0%, 80%, 100%": {
                  transform: "translateY(0) scale(0.8)",
                  opacity: 0.5,
                },
                "40%": { transform: "translateY(-4px) scale(1)", opacity: 1 },
              },
            }}
          />
        ))}
      </Box>
    </Box>
  );
}

// ─── Confirmation Card ────────────────────────────────────────────────────────

interface ConfirmationCardProps {
  summary: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmationCard({
  summary,
  onConfirm,
  onCancel,
}: ConfirmationCardProps) {
  const theme = useTheme();
  return (
    <Fade in timeout={300}>
      <Box sx={{ mb: 1.5 }}>
        <Paper
          elevation={0}
          sx={{
            p: 2,
            borderRadius: 3,
            border: `1px solid ${alpha(theme.palette.warning.main, 0.45)}`,
            bgcolor: alpha(theme.palette.warning.main, 0.06),
          }}
        >
          <Typography
            variant="body2"
            fontWeight={700}
            sx={{ mb: 0.5, color: "warning.dark" }}
          >
            Confirmation requise
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {summary}
          </Typography>
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              size="small"
              variant="contained"
              color="primary"
              onClick={onConfirm}
              startIcon={<CheckCircle size={14} />}
              sx={{
                borderRadius: 2,
                textTransform: "none",
                fontWeight: 600,
                fontSize: "0.8rem",
              }}
            >
              Confirmer
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              onClick={onCancel}
              startIcon={<XCircle size={14} />}
              sx={{
                borderRadius: 2,
                textTransform: "none",
                fontSize: "0.8rem",
              }}
            >
              Annuler
            </Button>
          </Box>
        </Paper>
      </Box>
    </Fade>
  );
}

// ─── History View (full-panel, replaces chat when open) ──────────────────────

interface HistoryViewProps {
  activeSessionId: number | null;
  onSelectSession: (id: number) => void;
  onNewChat: () => void;
  onBack: () => void;
  onClose: () => void;
}

function HistoryView({
  activeSessionId,
  onSelectSession,
  onNewChat,
  onBack,
  onClose,
}: HistoryViewProps) {
  const theme = useTheme();
  const { data, isLoading } = useGetSessionsQuery();
  const [renameSession] = useRenameSessionMutation();
  const [deleteSession] = useDeleteSessionMutation();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [hoveredSessionId, setHoveredSessionId] = useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const sessions = data?.data ?? [];

  const filteredSessions = search.trim()
    ? sessions.filter((s) => {
        const q = search.toLowerCase();
        return (
          s.title.toLowerCase().includes(q) ||
          s.lastMessage?.content.toLowerCase().includes(q)
        );
      })
    : sessions;

  const handleRename = async (id: number) => {
    if (!editTitle.trim()) return;
    try {
      await renameSession({ id, title: editTitle.trim() }).unwrap();
      setRenameError(null);
      setEditingId(null);
    } catch {
      setRenameError("Impossible de renommer la conversation.");
    }
  };

  return (
    <Box
      sx={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <GradientHeader>
        <Tooltip title="Retour au chat">
          <IconButton
            size="small"
            onClick={onBack}
            sx={{
              color: alpha("#fff", 0.85),
              "&:hover": { color: "#fff", bgcolor: alpha("#fff", 0.12) },
            }}
          >
            <ArrowLeft size={18} />
          </IconButton>
        </Tooltip>
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            bgcolor: alpha("#fff", 0.2),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <History size={16} color="#fff" />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="subtitle2"
            fontWeight={700}
            color="#fff"
            fontSize="0.85rem"
          >
            Historique
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: alpha("#fff", 0.75), fontSize: "0.65rem" }}
          >
            {sessions.length} conversation{sessions.length !== 1 ? "s" : ""}
          </Typography>
        </Box>
        <Tooltip title="Fermer">
          <IconButton
            size="small"
            onClick={onClose}
            sx={{
              color: alpha("#fff", 0.7),
              "&:hover": { color: "#fff", bgcolor: alpha("#fff", 0.1) },
            }}
          >
            <X size={16} />
          </IconButton>
        </Tooltip>
      </GradientHeader>

      {/* Search */}
      <Box sx={{ px: 2, pt: 1.5, pb: 0.5, flexShrink: 0 }}>
        <TextField
          fullWidth
          size="small"
          placeholder="Rechercher une conversation..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search size={14} color={theme.palette.text.disabled} />
                </InputAdornment>
              ),
            },
          }}
          sx={{
            "& .MuiInputBase-input": { py: 0.75, fontSize: "0.8rem" },
            "& .MuiOutlinedInput-root": {
              borderRadius: 2,
              bgcolor: alpha(theme.palette.background.default, 0.6),
              "& fieldset": { borderColor: alpha(theme.palette.divider, 0.5) },
              "&:hover fieldset": {
                borderColor: alpha(theme.palette.primary.main, 0.4),
              },
              "&.Mui-focused fieldset": {
                borderColor: theme.palette.primary.main,
              },
            },
          }}
        />
      </Box>

      {/* New conversation button */}
      <Box sx={{ px: 2, pt: 1, pb: 1, flexShrink: 0 }}>
        <Box
          onClick={onNewChat}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            p: 1.5,
            borderRadius: 2.5,
            cursor: "pointer",
            border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.45)}`,
            color: theme.palette.primary.main,
            transition: "all 0.2s",
            "&:hover": {
              bgcolor: alpha(theme.palette.primary.main, 0.06),
              borderColor: theme.palette.primary.main,
            },
          }}
        >
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: 2,
              bgcolor: alpha(theme.palette.primary.main, 0.1),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Plus size={16} />
          </Box>
          <Typography variant="body2" fontWeight={600} fontSize="0.85rem">
            Nouvelle conversation
          </Typography>
        </Box>
      </Box>

      {/* Session list */}
      <Box
        sx={{
          flex: 1,
          overflowY: "auto",
          px: 2,
          pb: 2,
          "&::-webkit-scrollbar": { width: 4 },
          "&::-webkit-scrollbar-thumb": {
            bgcolor: alpha(theme.palette.divider, 0.5),
            borderRadius: 2,
          },
        }}
      >
        {isLoading ? (
          <Box>
            {[...Array(5)].map((_, i) => (
              <Box
                key={i}
                sx={{
                  display: "flex",
                  gap: 1.5,
                  mb: 1.5,
                  alignItems: "center",
                }}
              >
                <Skeleton variant="circular" width={40} height={40} />
                <Box sx={{ flex: 1 }}>
                  <Skeleton variant="text" width="70%" height={18} />
                  <Skeleton variant="text" width="50%" height={14} />
                </Box>
              </Box>
            ))}
          </Box>
        ) : sessions.length === 0 ? (
          <Box sx={{ textAlign: "center", py: 6 }}>
            <Box
              sx={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                bgcolor: alpha(theme.palette.primary.main, 0.08),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                mx: "auto",
                mb: 2,
              }}
            >
              <MessageSquare size={24} color={theme.palette.text.disabled} />
            </Box>
            <Typography variant="body2" color="text.secondary" fontWeight={500}>
              Aucune conversation
            </Typography>
            <Typography
              variant="caption"
              color="text.disabled"
              display="block"
              mt={0.5}
            >
              Commencez une nouvelle conversation
            </Typography>
          </Box>
        ) : filteredSessions.length === 0 ? (
          <Box sx={{ textAlign: "center", py: 5 }}>
            <Box
              sx={{
                width: 48,
                height: 48,
                borderRadius: "50%",
                bgcolor: alpha(theme.palette.primary.main, 0.06),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                mx: "auto",
                mb: 1.5,
              }}
            >
              <Search size={20} color={theme.palette.text.disabled} />
            </Box>
            <Typography variant="body2" color="text.secondary" fontWeight={500}>
              Aucun résultat
            </Typography>
            <Typography
              variant="caption"
              color="text.disabled"
              display="block"
              mt={0.5}
            >
              Essayez d&apos;autres mots-clés
            </Typography>
          </Box>
        ) : (
          filteredSessions.map((session) => {
            const isActive = activeSessionId === session.id;
            return (
              <Box
                key={session.id}
                onClick={() =>
                  editingId !== session.id && onSelectSession(session.id)
                }
                onMouseEnter={() => setHoveredSessionId(session.id)}
                onMouseLeave={() => setHoveredSessionId(null)}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1.5,
                  p: 1.5,
                  mb: 1,
                  borderRadius: 2.5,
                  cursor: "pointer",
                  bgcolor: isActive
                    ? alpha(theme.palette.primary.main, 0.1)
                    : alpha(theme.palette.background.paper, 0.8),
                  border: `1px solid ${isActive ? alpha(theme.palette.primary.main, 0.35) : alpha(theme.palette.divider, 0.5)}`,
                  boxShadow: isActive
                    ? `0 2px 12px ${alpha(theme.palette.primary.main, 0.12)}`
                    : `0 1px 4px ${alpha(theme.palette.common.black, 0.04)}`,
                  transition: "all 0.18s",
                  "&:hover": {
                    bgcolor: isActive
                      ? alpha(theme.palette.primary.main, 0.12)
                      : alpha(theme.palette.background.paper, 1),
                    boxShadow: `0 4px 16px ${alpha(theme.palette.common.black, 0.08)}`,
                    transform: "translateY(-1px)",
                  },
                }}
              >
                {/* Icon */}
                <Box
                  sx={{
                    width: 40,
                    height: 40,
                    borderRadius: 2,
                    flexShrink: 0,
                    bgcolor: isActive
                      ? alpha(theme.palette.primary.main, 0.15)
                      : alpha(theme.palette.grey[500], 0.08),
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <MessageSquare
                    size={18}
                    color={
                      isActive
                        ? theme.palette.primary.main
                        : theme.palette.text.secondary
                    }
                  />
                </Box>

                {/* Content */}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {editingId === session.id ? (
                    <Box
                      sx={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 0.5,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Box sx={{ display: "flex", gap: 0.5 }}>
                        <TextField
                          size="small"
                          value={editTitle}
                          onChange={(e) => {
                            setEditTitle(e.target.value);
                            setRenameError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRename(session.id);
                            if (e.key === "Escape") {
                              setEditingId(null);
                              setRenameError(null);
                            }
                          }}
                          autoFocus
                          error={!!renameError}
                          sx={{
                            flex: 1,
                            "& .MuiInputBase-input": {
                              fontSize: "0.8rem",
                              py: 0.5,
                            },
                          }}
                        />
                        <IconButton
                          size="small"
                          onClick={() => handleRename(session.id)}
                          sx={{ color: "success.main" }}
                        >
                          <Check size={14} />
                        </IconButton>
                      </Box>
                      {renameError && (
                        <Typography
                          variant="caption"
                          sx={{
                            color: "error.main",
                            fontSize: "0.7rem",
                            pl: 0.5,
                          }}
                        >
                          {renameError}
                        </Typography>
                      )}
                    </Box>
                  ) : (
                    <>
                      <Typography
                        variant="body2"
                        fontWeight={isActive ? 700 : 500}
                        noWrap
                        sx={{
                          fontSize: "0.82rem",
                          color: isActive ? "primary.main" : "text.primary",
                          lineHeight: 1.3,
                        }}
                      >
                        {session.title}
                      </Typography>
                      {session.lastMessage && (
                        <Typography
                          variant="caption"
                          color="text.disabled"
                          noWrap
                          sx={{
                            fontSize: "0.72rem",
                            display: "block",
                            mt: 0.25,
                          }}
                        >
                          {session.lastMessage.role === "user"
                            ? "Vous: "
                            : "Assistant: "}
                          {session.lastMessage.content.slice(0, 45)}
                          {session.lastMessage.content.length > 45 ? "…" : ""}
                        </Typography>
                      )}
                      <Typography
                        variant="caption"
                        sx={{
                          fontSize: "0.68rem",
                          color: isActive
                            ? alpha(theme.palette.primary.main, 0.7)
                            : "text.disabled",
                        }}
                      >
                        {formatRelativeDate(
                          session.lastMessage?.createdAt ?? session.createdAt,
                        )}
                      </Typography>
                    </>
                  )}
                </Box>

                {/* Actions — always visible on touch, hover on desktop */}
                {editingId !== session.id && (
                  <Box
                    sx={{
                      display: "flex",
                      flexShrink: 0,
                      gap: 0.25,
                      opacity:
                        isMobile || hoveredSessionId === session.id ? 1 : 0,
                      transition: "opacity 0.15s",
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Tooltip title="Renommer">
                      <IconButton
                        size="small"
                        onClick={() => {
                          setEditingId(session.id);
                          setEditTitle(session.title);
                        }}
                        sx={{
                          p: 0.5,
                          color: "text.secondary",
                          borderRadius: 1.5,
                          "&:hover": {
                            color: "primary.main",
                            bgcolor: alpha(theme.palette.primary.main, 0.08),
                          },
                        }}
                      >
                        <Pencil size={13} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Supprimer">
                      <IconButton
                        size="small"
                        onClick={() => setDeleteConfirmId(session.id)}
                        sx={{
                          p: 0.5,
                          color: "text.secondary",
                          borderRadius: 1.5,
                          "&:hover": {
                            color: "error.main",
                            bgcolor: alpha(theme.palette.error.main, 0.08),
                          },
                        }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {/* ── Delete confirmation dialog ───────────────────────────────────── */}
      <Dialog
        open={deleteConfirmId !== null}
        onClose={() => setDeleteConfirmId(null)}
        PaperProps={{ sx: { borderRadius: 3, p: 0.5 } }}
      >
        <DialogTitle sx={{ fontWeight: 700, fontSize: "0.95rem", pb: 0.5 }}>
          Supprimer la conversation ?
        </DialogTitle>
        <DialogContent sx={{ pb: 1 }}>
          <DialogContentText sx={{ fontSize: "0.85rem" }}>
            Cette action est irréversible. Tous les messages de cette
            conversation seront supprimés.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
          <Button
            size="small"
            onClick={() => setDeleteConfirmId(null)}
            sx={{ borderRadius: 2, textTransform: "none", fontSize: "0.82rem" }}
          >
            Annuler
          </Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            onClick={() => {
              if (deleteConfirmId !== null) deleteSession(deleteConfirmId);
              setDeleteConfirmId(null);
            }}
            sx={{ borderRadius: 2, textTransform: "none", fontSize: "0.82rem" }}
          >
            Supprimer
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// ─── Chat View ────────────────────────────────────────────────────────────────

interface PendingConfirm {
  confirmId: string;
  tool: string;
  summary: string;
}

interface ChatViewProps {
  activeSessionId: number | null;
  localMessages: ChatMessage[];
  isTyping: boolean;
  loadingSession: boolean;
  input: string;
  expanded: boolean;
  isMobile: boolean;
  pendingConfirm: PendingConfirm | null;
  insightsBadge: number;
  onInput: (v: string) => void;
  onSend: (text: string, attachment?: ChatAttachment) => void;
  onUploadFile: (file: File | Blob, name?: string) => Promise<ChatAttachment>;
  onShowHistory: () => void;
  onShowInsights: () => void;
  onNewChat: () => void;
  onToggleExpand: () => void;
  onClose: () => void;
  onStop: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

function ChatView({
  activeSessionId,
  localMessages,
  isTyping,
  loadingSession,
  input,
  expanded,
  isMobile,
  pendingConfirm,
  insightsBadge,
  onInput,
  onSend,
  onUploadFile,
  onShowHistory,
  onShowInsights,
  onNewChat,
  onToggleExpand,
  onClose,
  onStop,
  onConfirm,
  onCancel,
  messagesEndRef,
  inputRef,
}: ChatViewProps) {
  const theme = useTheme();

  return (
    <Box
      sx={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <GradientHeader>
        {/* FINORA logo — white wordmark + orange sunburst, works on dark gradient */}
        <Box
          component="img"
          src="/assets/logo-finora.png"
          alt="Finora"
          onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
            e.currentTarget.style.display = "none";
          }}
          sx={{
            height: 22,
            width: "auto",
            flexShrink: 0,
            objectFit: "contain",
          }}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="subtitle2"
            fontWeight={700}
            color="#fff"
            noWrap
            fontSize="0.82rem"
            sx={{ letterSpacing: "0.01em" }}
          >
            Assistant IA
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Box
              sx={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                bgcolor: "#10B981",
                flexShrink: 0,
                animation: "pulse-dot 2s ease-in-out infinite",
                "@keyframes pulse-dot": {
                  "0%, 100%": { opacity: 1, transform: "scale(1)" },
                  "50%": { opacity: 0.6, transform: "scale(0.85)" },
                },
              }}
            />
            <Typography
              variant="caption"
              sx={{ color: alpha("#fff", 0.75), fontSize: "0.64rem" }}
            >
              Comptabilité · Finance · Analyse
            </Typography>
          </Box>
        </Box>
        <Box sx={{ display: "flex", gap: 0.25 }}>
          <Tooltip title="Historique des conversations">
            <IconButton
              size="small"
              onClick={onShowHistory}
              sx={{
                color: alpha("#fff", 0.7),
                "&:hover": { color: "#fff", bgcolor: alpha("#fff", 0.1) },
              }}
            >
              <History size={15} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Insights IA">
            <IconButton
              size="small"
              onClick={onShowInsights}
              sx={{
                color: alpha("#fff", 0.7),
                "&:hover": { color: "#fff", bgcolor: alpha("#fff", 0.1) },
              }}
            >
              <Badge
                badgeContent={insightsBadge}
                max={9}
                sx={{
                  "& .MuiBadge-badge": {
                    bgcolor: insightsBadge > 0 ? "#EF4444" : "transparent",
                    color: "#fff",
                    fontSize: "0.6rem",
                    minWidth: 14,
                    height: 14,
                    padding: "0 3px",
                  },
                }}
              >
                <Zap size={15} />
              </Badge>
            </IconButton>
          </Tooltip>
          <Tooltip title="Nouvelle conversation">
            <IconButton
              size="small"
              onClick={onNewChat}
              sx={{
                color: alpha("#fff", 0.7),
                "&:hover": { color: "#fff", bgcolor: alpha("#fff", 0.1) },
              }}
            >
              <Plus size={15} />
            </IconButton>
          </Tooltip>
          {!isMobile && (
            <Tooltip title={expanded ? "Réduire" : "Agrandir"}>
              <IconButton
                size="small"
                onClick={onToggleExpand}
                sx={{
                  color: alpha("#fff", 0.7),
                  "&:hover": { color: "#fff", bgcolor: alpha("#fff", 0.1) },
                }}
              >
                {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Fermer">
            <IconButton
              size="small"
              onClick={onClose}
              sx={{
                color: alpha("#fff", 0.7),
                "&:hover": { color: "#fff", bgcolor: alpha("#fff", 0.1) },
              }}
            >
              <X size={15} />
            </IconButton>
          </Tooltip>
        </Box>
      </GradientHeader>

      {/* Messages */}
      <Box
        sx={{
          flex: 1,
          overflowY: "auto",
          px: 2,
          py: 1.5,
          display: "flex",
          flexDirection: "column",
          bgcolor: alpha(theme.palette.background.default, 0.6),
          "&::-webkit-scrollbar": { width: 4 },
          "&::-webkit-scrollbar-thumb": {
            bgcolor: alpha(theme.palette.divider, 0.5),
            borderRadius: 2,
          },
        }}
      >
        {loadingSession ? (
          <Box sx={{ pt: 2 }}>
            {[...Array(3)].map((_, i) => (
              <Box
                key={i}
                sx={{
                  display: "flex",
                  gap: 1,
                  mb: 2,
                  flexDirection: i % 2 === 0 ? "row" : "row-reverse",
                }}
              >
                <Skeleton variant="circular" width={30} height={30} />
                <Skeleton
                  variant="rounded"
                  width="60%"
                  height={48}
                  sx={{ borderRadius: 3 }}
                />
              </Box>
            ))}
          </Box>
        ) : (
          localMessages.map((msg, i) => {
            if (msg.localId === "welcome") {
              return <WelcomeCard key="welcome" />;
            }
            return (
              <MessageBubble
                key={msg.localId ?? msg.id?.toString() ?? `fallback-${i}`}
                msg={msg}
              />
            );
          })
        )}
        {isTyping && !localMessages[localMessages.length - 1]?.isLoading && (
          <TypingIndicator />
        )}
        {pendingConfirm && !isTyping && (
          <ConfirmationCard
            summary={pendingConfirm.summary}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        )}
        <div ref={messagesEndRef} />
      </Box>

      {/* Suggested prompts — only on fresh chat */}
      {!activeSessionId && localMessages.length <= 1 && !isTyping && (
        <Box
          sx={{
            px: 1.5,
            pb: 1.25,
            pt: 1,
            display: "flex",
            gap: 0.65,
            flexWrap: "wrap",
            borderTop: `1px solid ${alpha(theme.palette.divider, 0.4)}`,
            bgcolor: alpha(theme.palette.background.paper, 0.5),
          }}
        >
          {SUGGESTED_PROMPTS.map(({ label, icon, prompt }) => (
            <Chip
              key={prompt}
              icon={icon as React.ReactElement}
              label={label}
              size="small"
              onClick={() => onSend(prompt)}
              sx={{
                fontSize: "0.7rem",
                height: 26,
                cursor: "pointer",
                bgcolor: "transparent",
                color: theme.palette.primary.main,
                border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
                fontWeight: 400,
                transition: "all 0.15s",
                "&:hover": {
                  bgcolor: alpha(theme.palette.primary.main, 0.06),
                  borderColor: alpha(theme.palette.primary.main, 0.35),
                },
                "& .MuiChip-label": { px: 0.75 },
                "& .MuiChip-icon": {
                  color: theme.palette.primary.main,
                  ml: 0.75,
                },
              }}
            />
          ))}
        </Box>
      )}

      {/* Input — modern bar with file + mic + send */}
      <ChatInputBar
        value={input}
        onChange={onInput}
        onSend={onSend}
        uploadFile={onUploadFile}
        onStop={onStop}
        isTyping={isTyping}
        disabled={isTyping}
        inputRef={inputRef}
      />
    </Box>
  );
}

// ─── Root Widget ──────────────────────────────────────────────────────────────

export default function ChatbotWidget() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { pathname } = useLocation();

  // Hide entirely on mobile when on the messages page — the chat window is
  // full-screen there and the FAB would overlap the send button.
  const isInChatRoom = isMobile && /\/messages/.test(pathname);

  const { user } = useAppSelector((state) => state.auth);
  const userRole =
    typeof user?.role === "object" ? user?.role?.code : user?.role;
  const isClient =
    userRole?.toUpperCase() === ROLE_CODES.CLIENT ||
    userRole?.toUpperCase() === "CLIENT";

  // ── State ──────────────────────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // 'chat' | 'history' | 'insights' — controls which full-panel view is shown
  const [view, setView] = useState<"chat" | "history" | "insights">("chat");
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null,
  );

  // ── Insights badge ─────────────────────────────────────────────────────────
  const { data: insightsData } = useGetInsightsQuery(undefined, {
    pollingInterval: 5 * 60 * 1000,
  });
  const insightsBadge =
    insightsData?.data?.filter(
      (i) => i.severity === "critical" || i.severity === "warning",
    ).length ?? 0;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const msgIdCounter = useRef(0);
  const isTypingRef = useRef(false);
  const genLocalId = useCallback(
    () => `local-${Date.now()}-${++msgIdCounter.current}`,
    [],
  );
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatch = useAppDispatch();
  const [sendMessage] = useSendMessageMutation();
  const [uploadAttachmentMutation] = useUploadAttachmentMutation();
  const { data: sessionData, isFetching: loadingSession } = useGetSessionQuery(
    activeSessionId!,
    { skip: !activeSessionId },
  );

  // ── Effects ────────────────────────────────────────────────────────────────

  // Keep ref in sync so scrollToBottom can read current typing state without
  // being recreated (which would retrigger the scroll useEffect) on every change.
  useEffect(() => {
    isTypingRef.current = isTyping;
  }, [isTyping]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: isTypingRef.current ? "instant" : "smooth",
    });
  }, []);

  useEffect(() => {
    if (open && view === "chat") scrollToBottom();
  }, [localMessages, isTyping, open, view, scrollToBottom]);

  useEffect(() => {
    if (open && view === "chat") {
      setHasUnread(false);
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [open, view]);

  // Populate messages when a session is loaded from DB.
  // Skip while SSE is in progress — the streaming logic owns localMessages during
  // that window and replacing them would lose the in-flight assistant bubble.
  //
  // Guard against premature overwrite: if the DB data has fewer real messages than
  // what we already have locally, the refetch completed before the backend finished
  // saving the streamed messages. In that case we keep the local state as the source
  // of truth. The correct data will arrive once RTK Query re-fetches after the tag
  // invalidated by message_done propagates.
  useEffect(() => {
    if (sessionData?.data?.messages && !isTyping) {
      setLocalMessages((prev) => {
        const dbMessages = sessionData.data.messages.map((m) => {
          // Safety net: if the backend didn't reconstruct a nested attachment object
          // (e.g. presigned URL failed), rebuild it from the flat fields when present.
          const raw = m as ChatMessage & {
            attachmentObjectPath?: string;
            attachmentName?: string;
            attachmentMimeType?: string;
            attachmentSize?: number;
          };
          const attachment: ChatAttachment | undefined =
            m.attachment ??
            (raw.attachmentObjectPath
              ? {
                  url: "",
                  name: raw.attachmentName ?? raw.attachmentObjectPath,
                  mimeType:
                    raw.attachmentMimeType ?? "application/octet-stream",
                  size: raw.attachmentSize ?? 0,
                  objectPath: raw.attachmentObjectPath,
                }
              : undefined);
          return {
            ...m,
            attachment,
            timestamp: new Date(m.createdAt!).getTime(),
            localId: `db-${m.id}`,
          };
        });

        // Count real messages in local state — exclude the ephemeral welcome card
        // and any still-loading assistant bubbles from the count.
        const prevReal = prev.filter(
          (m) => m.localId !== "welcome" && !m.isLoading,
        );

        // DB fetch returned fewer messages than we already have locally → the backend
        // hasn't saved everything yet. Keep local state; the next re-fetch will fix it.
        if (dbMessages.length < prevReal.length) return prev;

        // Preserve "local-" prefixed localIds by position so React keys stay
        // stable across the optimistic→DB transition (avoids Fade replay).
        return dbMessages.map((dbMsg, idx) => {
          const prevMsg = prevReal[idx];
          if (prevMsg?.localId?.startsWith("local-")) {
            return { ...dbMsg, localId: prevMsg.localId };
          }
          return dbMsg;
        });
      });
    }
  }, [sessionData, isTyping]);

  // Welcome message for a fresh chat
  useEffect(() => {
    if (!activeSessionId && localMessages.length === 0) {
      setLocalMessages([
        {
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          localId: "welcome",
        },
      ]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // Abort any in-progress stream on unmount
  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current);
    };
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSelectSession = (id: number) => {
    // Invalidate stale cache so attachments get fresh presigned URLs
    dispatch(
      chatbotApi.util.invalidateTags([{ type: "ChatSession" as const, id }]),
    );
    setActiveSessionId(id);
    setLocalMessages([]);
    setPendingConfirm(null);
    setView("chat");
  };

  const handleNewChat = () => {
    setActiveSessionId(null);
    setLocalMessages([
      {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        localId: "welcome",
      },
    ]);
    setPendingConfirm(null);
    setView("chat");
  };

  const handleSend = async (
    text?: string,
    opts?: { confirmId?: string; attachment?: ChatAttachment },
  ) => {
    const messageText = (text ?? input).trim();
    const isConfirm = !!opts?.confirmId;
    const attachment = opts?.attachment;
    if ((!messageText && !attachment) || isTyping) return;

    // Mutable local variable — updated as soon as a session ID becomes known via
    // message_start or fallback. Avoids the stale closure on activeSessionId (which
    // is null for new conversations at the time handleSend is called).
    let resolvedSessionId: number | null = activeSessionId;

    const assistantLocalId = genLocalId();

    if (isConfirm) {
      // Confirmation: just add a loading assistant bubble, no user message
      setLocalMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "",
          toolsUsed: [],
          timestamp: Date.now(),
          localId: assistantLocalId,
          isLoading: true,
        },
      ]);
    } else {
      setLocalMessages((prev) => [
        ...prev,
        {
          role: "user",
          content: messageText,
          timestamp: Date.now(),
          localId: genLocalId(),
          attachment,
        },
        {
          role: "assistant",
          content: "",
          toolsUsed: [],
          timestamp: Date.now(),
          localId: assistantLocalId,
          isLoading: true,
        },
      ]);
      setInput("");
    }
    setIsTyping(true);

    // ── Fallback: use the regular non-streaming endpoint ──────────────────
    const fallback = async () => {
      if (isConfirm) {
        // No fallback for confirmations — non-streaming endpoint doesn't handle confirmId
        setLocalMessages((prev) =>
          prev.map((m) =>
            m.localId === assistantLocalId
              ? {
                  ...m,
                  content:
                    "Erreur lors de la confirmation. Veuillez réessayer.",
                  isLoading: false,
                }
              : m,
          ),
        );
        return;
      }
      try {
        const result = await sendMessage({
          message: messageText,
          sessionId: activeSessionId ?? undefined,
          attachment,
        }).unwrap();

        if (!activeSessionId) {
          resolvedSessionId = result.sessionId;
          setActiveSessionId(result.sessionId);
        }

        setLocalMessages((prev) =>
          prev.map((m) =>
            m.localId === assistantLocalId
              ? {
                  ...m,
                  content: result.reply,
                  toolsUsed: result.toolsUsed,
                  isLoading: false,
                }
              : m,
          ),
        );
        if (!open) setHasUnread(true);
      } catch {
        setLocalMessages((prev) =>
          prev.map((m) =>
            m.localId === assistantLocalId
              ? {
                  ...m,
                  content:
                    "Désolé, une erreur s'est produite. Veuillez réessayer.",
                  isLoading: false,
                }
              : m,
          ),
        );
      }
    };

    // ── SSE streaming ─────────────────────────────────────────────────────
    const controller = new AbortController();
    streamAbortRef.current = controller;

    // Abort if no SSE chunk arrives for 45 s (server hang / network stall)
    const scheduleTimeout = () => {
      if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current);
      streamTimeoutRef.current = setTimeout(() => controller.abort(), 45_000);
    };

    try {
      const token = localStorage.getItem("token");
      const apiUrl = import.meta.env.VITE_API_URL as string;

      const response = await fetch(`${apiUrl}/chatbot/message/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: messageText,
          sessionId: activeSessionId ?? undefined,
          ...(opts?.confirmId ? { confirmId: opts.confirmId } : {}),
          ...(attachment ? { attachment } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        await fallback();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleEvent = (eventName: string, dataStr: string) => {
        try {
          const data = JSON.parse(dataStr);
          switch (eventName) {
            case "message_start":
              if (data.sessionId) {
                resolvedSessionId = data.sessionId as number;
                setActiveSessionId(data.sessionId as number);
              }
              break;

            case "confirm_required":
              setPendingConfirm({
                confirmId: data.confirmId as string,
                tool: data.tool as string,
                summary: data.summary as string,
              });
              break;

            case "token":
              if (data.content) {
                setLocalMessages((prev) =>
                  prev.map((m) =>
                    m.localId === assistantLocalId
                      ? { ...m, content: m.content + (data.content as string) }
                      : m,
                  ),
                );
              }
              break;

            case "tool_start":
              if (data.tool) {
                setLocalMessages((prev) =>
                  prev.map((m) =>
                    m.localId === assistantLocalId
                      ? {
                          ...m,
                          toolsUsed: m.toolsUsed?.includes(data.tool as string)
                            ? m.toolsUsed
                            : [...(m.toolsUsed ?? []), data.tool as string],
                        }
                      : m,
                  ),
                );
              }
              break;

            case "message_done": {
              const usedTools = (data.toolsUsed as string[]) ?? [];
              const userTranscription = data.userTranscription as
                | string
                | null
                | undefined;
              setLocalMessages((prev) => {
                const assistantIdx = prev.findIndex(
                  (m) => m.localId === assistantLocalId,
                );
                return prev.map((m, idx) => {
                  if (m.localId === assistantLocalId) {
                    return {
                      ...m,
                      content: (data.reply as string) ?? m.content,
                      toolsUsed: usedTools.length ? usedTools : m.toolsUsed,
                      isLoading: false,
                    };
                  }
                  if (
                    userTranscription &&
                    assistantIdx > 0 &&
                    idx === assistantIdx - 1 &&
                    m.role === "user"
                  ) {
                    return { ...m, transcription: userTranscription };
                  }
                  return m;
                });
              });
              dispatch(
                chatbotApi.util.invalidateTags([
                  "ChatSessions",
                  ...(resolvedSessionId
                    ? [{ type: "ChatSession" as const, id: resolvedSessionId }]
                    : []),
                ]),
              );
              // Only invalidate domain caches when the action was actually executed
              // (wasExecuted is false when we're just awaiting confirmation)
              if (data.wasExecuted) {
                if (
                  usedTools.some((t) =>
                    ["mark_invoice_paid", "create_invoice"].includes(t),
                  )
                ) {
                  dispatch(
                    invoicesApi.util.invalidateTags([
                      { type: "Invoices", id: "LIST" },
                    ]),
                  );
                  dispatch(factureApi.util.invalidateTags(["FactureList"]));
                }
                if (usedTools.includes("create_task")) {
                  dispatch(
                    tasksApi.util.invalidateTags([
                      { type: "Tasks", id: "MY_CREATED_LIST" },
                    ]),
                  );
                }
                if (usedTools.includes("create_appointment")) {
                  dispatch(
                    appointmentsApi.util.invalidateTags([
                      { type: "Appointments", id: "LIST" },
                    ]),
                  );
                }
                if (usedTools.includes("create_devis")) {
                  dispatch(devisApi.util.invalidateTags(["DevisList"]));
                }
              }
              if (!open) setHasUnread(true);
              break;
            }

            case "error":
              setLocalMessages((prev) =>
                prev.map((m) =>
                  m.localId === assistantLocalId
                    ? {
                        ...m,
                        content:
                          (data.message as string) ??
                          "Désolé, une erreur s'est produite. Veuillez réessayer.",
                        isLoading: false,
                      }
                    : m,
                ),
              );
              break;
            default:
              break;
          }
        } catch {
          // ignore malformed SSE data
        }
      };

      scheduleTimeout(); // abort if first chunk doesn't arrive within 45 s

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        scheduleTimeout(); // reset timeout on every received chunk

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const block of parts) {
          let eventName = "";
          let dataStr = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataStr = line.slice(6);
          }
          if (eventName && dataStr) handleEvent(eventName, dataStr);
        }
      }

      // Stream closed without message_done — resolve any stuck loading bubble
      setLocalMessages((prev) =>
        prev.map((m) =>
          m.localId === assistantLocalId && m.isLoading
            ? { ...m, isLoading: false }
            : m,
        ),
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        // User stopped or 45 s timeout — show partial content or a clear error
        setLocalMessages((prev) =>
          prev.map((m) =>
            m.localId === assistantLocalId
              ? {
                  ...m,
                  content:
                    m.content ||
                    "Désolé, la réponse a été interrompue. Veuillez réessayer.",
                  isLoading: false,
                }
              : m,
          ),
        );
      } else {
        // Network or parse error — fallback to regular endpoint
        await fallback();
      }
    } finally {
      if (streamTimeoutRef.current) {
        clearTimeout(streamTimeoutRef.current);
        streamTimeoutRef.current = null;
      }
      streamAbortRef.current = null;
      setIsTyping(false);
    }
  };

  const handleUploadFile = useCallback(
    async (file: File | Blob, name?: string): Promise<ChatAttachment> => {
      const formData = new FormData();
      if (file instanceof File) {
        formData.append("file", file);
      } else {
        formData.append(
          "file",
          new File([file], name ?? "attachment", { type: file.type }),
        );
      }
      const result = await uploadAttachmentMutation(formData).unwrap();
      return result.data;
    },
    [uploadAttachmentMutation],
  );

  const handleConfirm = () => {
    if (!pendingConfirm || !activeSessionId) return;
    const { confirmId } = pendingConfirm;
    setPendingConfirm(null);
    handleSend("__CONFIRM__", { confirmId });
  };

  const handleCancel = () => {
    setPendingConfirm(null);
  };

  const handleStop = useCallback(() => {
    streamAbortRef.current?.abort();
  }, []);

  // Handle prompt from InsightsPanel — switch to chat and send
  const handleInsightPrompt = (prompt: string) => {
    setView("chat");
    // Small delay to let the view transition complete
    setTimeout(() => {
      setInput(prompt);
      setTimeout(() => handleSend(prompt), 50);
    }, 100);
  };

  // ── Early returns AFTER all hooks ──────────────────────────────────────────

  // Only render for CLIENT role
  if (!isClient) return null;

  // Don't render at all on mobile inside a chat room — avoids blocking the input bar
  if (isInChatRoom) return null;

  // ── Dimensions ─────────────────────────────────────────────────────────────
  // History view is always the same width as the chat panel — no sidebar squeezing
  const panelWidth = isMobile ? "100vw" : expanded ? 480 : 380;
  const panelHeight = isMobile ? "100dvh" : expanded ? 680 : 520;

  return (
    <>
      {/* ── FAB — hidden on mobile when panel is open (panel is full-screen) */}
      {!(isMobile && open) && (
        <Tooltip title="Assistant financier" placement="left">
          <Fab
            onClick={() => setOpen((v) => !v)}
            sx={{
              position: "fixed",
              bottom: { xs: 88, sm: 24 },
              right: { xs: 16, sm: 24 },
              zIndex: 1300,
              width: 56,
              height: 56,
              background:
                "linear-gradient(135deg, #0a2251 0%, #1d61e7 55%, #1649ad 100%)",
              color: "#fff",
              boxShadow: `0 6px 20px ${alpha(theme.palette.primary.main, 0.4)}`,
              transition: "all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)",
              "&:hover": {
                transform: "scale(1.08)",
                boxShadow: `0 8px 28px ${alpha(theme.palette.primary.main, 0.5)}`,
              },
            }}
          >
            {hasUnread && (
              <Box
                sx={{
                  position: "absolute",
                  top: 6,
                  right: 6,
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  bgcolor: "#EF4444",
                  border: "2px solid #fff",
                  animation: "pulse 1.5s infinite",
                  "@keyframes pulse": {
                    "0%, 100%": { transform: "scale(1)" },
                    "50%": { transform: "scale(1.3)" },
                  },
                }}
              />
            )}
            <MessageCircle size={22} />
          </Fab>
        </Tooltip>
      )}

      {/* ── Panel ───────────────────────────────────────────────────────── */}
      <Collapse
        in={open}
        timeout={300}
        sx={{
          position: "fixed",
          bottom: isMobile ? 0 : 92,
          right: isMobile ? 0 : 24,
          zIndex: 1301,
          transformOrigin: "bottom right",
        }}
      >
        <Paper
          elevation={0}
          sx={{
            width: panelWidth,
            height: panelHeight,
            display: "flex",
            flexDirection: "column",
            borderRadius: isMobile ? 0 : 4,
            overflow: "hidden",
            border: `1px solid ${alpha(theme.palette.primary.main, 0.12)}`,
            boxShadow: `0 32px 80px ${alpha(theme.palette.common.black, 0.2)}, 0 0 0 1px ${alpha(theme.palette.primary.main, 0.06)}`,
            bgcolor: alpha(theme.palette.background.default, 0.97),
            backdropFilter: "blur(20px)",
            // Slide animation between views
            "& > *": { transition: "opacity 0.2s ease" },
          }}
        >
          {view === "history" ? (
            <HistoryView
              activeSessionId={activeSessionId}
              onSelectSession={handleSelectSession}
              onNewChat={handleNewChat}
              onBack={() => setView("chat")}
              onClose={() => setOpen(false)}
            />
          ) : view === "insights" ? (
            <Box
              sx={{
                width: "100%",
                height: "100%",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* Insights header — same gradient as chat */}
              <GradientHeader>
                <Tooltip title="Retour au chat">
                  <IconButton
                    size="small"
                    onClick={() => setView("chat")}
                    sx={{
                      color: alpha("#fff", 0.85),
                      "&:hover": {
                        color: "#fff",
                        bgcolor: alpha("#fff", 0.12),
                      },
                    }}
                  >
                    <ArrowLeft size={18} />
                  </IconButton>
                </Tooltip>
                <Box
                  sx={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    bgcolor: alpha("#fff", 0.2),
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Zap size={16} color="#fff" />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    variant="subtitle2"
                    fontWeight={700}
                    color="#fff"
                    fontSize="0.85rem"
                  >
                    Insights IA
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ color: alpha("#fff", 0.75), fontSize: "0.65rem" }}
                  >
                    Alertes intelligentes · données réelles
                  </Typography>
                </Box>
                <Tooltip title="Fermer">
                  <IconButton
                    size="small"
                    onClick={() => setOpen(false)}
                    sx={{
                      color: alpha("#fff", 0.7),
                      "&:hover": { color: "#fff", bgcolor: alpha("#fff", 0.1) },
                    }}
                  >
                    <X size={15} />
                  </IconButton>
                </Tooltip>
              </GradientHeader>
              <InsightsPanel onAskChatbot={handleInsightPrompt} />
            </Box>
          ) : (
            <ChatView
              activeSessionId={activeSessionId}
              localMessages={localMessages}
              isTyping={isTyping}
              loadingSession={loadingSession}
              input={input}
              expanded={expanded}
              isMobile={isMobile}
              pendingConfirm={pendingConfirm}
              insightsBadge={insightsBadge}
              onInput={setInput}
              onSend={(text, att) =>
                handleSend(text, att ? { attachment: att } : undefined)
              }
              onUploadFile={handleUploadFile}
              onShowHistory={() => setView("history")}
              onShowInsights={() => setView("insights")}
              onNewChat={handleNewChat}
              onToggleExpand={() => setExpanded((v) => !v)}
              onClose={() => setOpen(false)}
              onStop={handleStop}
              onConfirm={handleConfirm}
              onCancel={handleCancel}
              messagesEndRef={messagesEndRef}
              inputRef={inputRef}
            />
          )}
        </Paper>
      </Collapse>
    </>
  );
}
