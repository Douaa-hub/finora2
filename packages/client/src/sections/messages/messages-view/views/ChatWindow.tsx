import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import LinearProgress from "@mui/material/LinearProgress";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";

import { messageRequests } from "../data/mock";
import type {
  Conversation,
  Message,
  MessageRequest,
  MessageTask,
  MessageAppointment,
} from "../data/types";
import ChatHeader from "../components/ChatHeader";
import MessageInput from "../components/MessageInput";
import MessageBubble from "../components/MessageBubble";
import MessagesDateDivider from "../components/MessagesDateDivider";

type ChatWindowProps = {
  conversationId: number;
  conversation?: Conversation;
  messages: Message[];
  isCommunicationConfirmed: boolean;
  onMessagesChange: (messages: Message[]) => void;
  onSendMessage?: (content: string) => void;
  onSendFile?: (
    text: string,
    file?: File,
    request?: MessageRequest,
    task?: MessageTask,
    appointment?: MessageAppointment,
  ) => void;
  onOpenMedia?: () => void;
  onBack?: () => void;
  recipientType?: "client" | "collaborator" | null;
  recipientId?: number | null;
  isRemoteTyping?: boolean;
  onTypingChange?: (typing: boolean) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onMarkAsRead?: () => void;
  uploadProgress?: number;
  isUploading?: boolean;
};

function htmlToText(html: string) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || "").replace(/\u00a0/g, " ").trim();
}

function hasFlagNode(html: string) {
  return html.includes('data-flag-code="');
}

export default function ChatWindow({
  conversationId,
  conversation,
  messages,
  isCommunicationConfirmed,
  onMessagesChange,
  onSendMessage,
  onSendFile,
  onOpenMedia,
  onBack,
  recipientType,
  recipientId,
  isRemoteTyping = false,
  onTypingChange,
  onLoadMore,
  hasMore = false,
  isLoadingMore = false,
  onMarkAsRead,
  uploadProgress = 0,
  isUploading = false,
}: ChatWindowProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const isMedium = useMediaQuery(theme.breakpoints.between("md", "lg"));

  const currentConversation = conversation;

  const [inputValue, setInputValue] = useState("");
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesBottomRef = useRef<HTMLDivElement | null>(null);

  // Scroll-position preservation when older messages are prepended
  const loadingOlderRef = useRef(false);
  const savedScrollHeightRef = useRef(0);
  const justRestoredScrollRef = useRef(false);

  useEffect(() => {
    setInputValue("");
  }, [conversationId]);

  // Restore scroll position synchronously after older messages are prepended
  useLayoutEffect(() => {
    if (!loadingOlderRef.current) return;
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight - savedScrollHeightRef.current;
    loadingOlderRef.current = false;
    justRestoredScrollRef.current = true;
  }, [messages]);

  // Scroll to bottom on new messages / conversation change (skip when restoring)
  useEffect(() => {
    if (justRestoredScrollRef.current) {
      justRestoredScrollRef.current = false;
      return;
    }
    messagesBottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages, conversationId]);

  // Reveal the typing indicator when it appears, but only if the user is
  // already near the bottom — never yank them down while they're reading
  // older messages further up.
  useEffect(() => {
    if (!isRemoteTyping) return;
    const container = messagesContainerRef.current;
    if (!container) return;
    const NEAR_BOTTOM_PX = 120;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < NEAR_BOTTOM_PX) {
      messagesBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [isRemoteTyping]);

  // Scroll listener — triggers older message loading when near the top
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return undefined;

    const handleScroll = () => {
      if (
        container.scrollTop < 80 &&
        hasMore &&
        onLoadMore &&
        !isLoadingMore &&
        !loadingOlderRef.current
      ) {
        savedScrollHeightRef.current = container.scrollHeight;
        loadingOlderRef.current = true;
        onLoadMore();
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasMore, onLoadMore, isLoadingMore]);

  // Emit typing:start only on the leading edge of a typing session (not on
  // every keystroke), then auto-stop after 2s of inactivity.
  const handleInputChange = (val: string) => {
    setInputValue(val);
    if (!onTypingChange) return;
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      onTypingChange(true);
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false;
      onTypingChange(false);
    }, 2000);
  };

  // Cancels the pending auto-stop timer and resets typing state immediately —
  // called right before sending, so typing:stop always fires on send rather
  // than waiting for the 2s timeout.
  const stopTypingNow = () => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    isTypingRef.current = false;
    onTypingChange?.(false);
  };

  useEffect(
    () => () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    },
    [],
  );

  const formatDateLabel = (date: string) => {
    const today = new Date().toISOString().split("T")[0];

    if (date === today) {
      return "Aujourd'hui";
    }

    return new Date(date).toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  };

  const shouldShowDateDivider = (
    currentMessage: Message,
    previousMessage?: Message,
  ) => {
    if (!previousMessage) return true;
    return currentMessage.date !== previousMessage.date;
  };

  const formatFileSize = (size: number) => {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleSendMessage = (
    messageHtml: string,
    file?: File,
    request?: MessageRequest,
    task?: MessageTask,
    appointment?: MessageAppointment,
  ) => {
    if (!isCommunicationConfirmed) return;

    stopTypingNow();

    const now = new Date();
    const formattedTime = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const formattedDate = now.toISOString().split("T")[0];
    const plainText = htmlToText(messageHtml);

    if (request) {
      const newMessage: Message = {
        id: Date.now(),
        type: "request",
        mine: true,
        time: formattedTime,
        date: formattedDate,
        text: plainText,
        html: messageHtml,
        request: {
          id: request.id,
          title: request.title,
          subtitle: request.subtitle,
          dateLabel: request.dateLabel,
          status: request.status,
          urgency: request.urgency,
        },
      };

      onMessagesChange([...messages, newMessage]);
      onSendFile?.(messageHtml, undefined, request, undefined, undefined);
      setInputValue("");
      return;
    }

    if (task) {
      const newMessage: Message = {
        id: Date.now(),
        type: "task",
        mine: true,
        time: formattedTime,
        date: formattedDate,
        text: plainText,
        html: messageHtml,
        task,
      };

      onMessagesChange([...messages, newMessage]);
      onSendFile?.(messageHtml, undefined, undefined, task, undefined);
      setInputValue("");
      return;
    }

    if (appointment) {
      const newMessage: Message = {
        id: Date.now(),
        type: "appointment",
        mine: true,
        time: formattedTime,
        date: formattedDate,
        text: plainText,
        html: messageHtml,
        appointment,
      };

      onMessagesChange([...messages, newMessage]);
      onSendFile?.(messageHtml, undefined, undefined, undefined, appointment);
      setInputValue("");
      return;
    }

    if (file) {
      onSendFile?.(messageHtml, file);

      const newMessage: Message = {
        id: Date.now(),
        type: "file",
        mine: true,
        time: formattedTime,
        date: formattedDate,
        text: plainText,
        html: messageHtml,
        file: {
          name: file.name,
          size: formatFileSize(file.size),
          type: file.type,
          url: URL.createObjectURL(file),
        },
      };

      onMessagesChange([...messages, newMessage]);
      setInputValue("");
      return;
    }

    if (!plainText && !hasFlagNode(messageHtml)) {
      return;
    }

    const newMessage: Message = {
      id: Date.now(),
      type: "text",
      text: plainText,
      html: messageHtml,
      mine: true,
      time: formattedTime,
      date: formattedDate,
    };

    onSendMessage?.(plainText);
    onMessagesChange([...messages, newMessage]);
    setInputValue("");
  };

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: isMobile ? "14px" : "18px",
        border: isMobile ? "none" : "1px solid #F2F4F7",
        backgroundColor: "#FFFFFF",
      }}
    >
      <Box
        sx={{
          flexShrink: 0,
          px: { xs: 1, md: 2 },
          pt: { xs: 2.5, md: 1.75 },
          pb: { xs: 1, md: 1.25 },
          borderBottom: "1px solid #F2F4F7",
          backgroundColor: "#FFFFFF",
        }}
      >
        <ChatHeader
          conversation={currentConversation}
          onOpenMedia={onOpenMedia}
          onBack={onBack}
        />
      </Box>

      <Box
        ref={messagesContainerRef}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          px: { xs: 0.75, md: 2.25 },
          pt: { xs: 1, md: 1.5 },
          pb: { xs: 0.5, md: 1.25 },
          backgroundColor: "#FFFFFF",
          "&::-webkit-scrollbar": {
            width: 6,
          },
          "&::-webkit-scrollbar-thumb": {
            backgroundColor: "#E4E7EC",
            borderRadius: "999px",
          },
        }}
      >
        {/* Loading indicator for older messages */}
        {isLoadingMore && (
          <Box
            sx={{
              display: "flex",
              justifyContent: "center",
              py: 1.5,
            }}
          >
            <CircularProgress size={18} sx={{ color: "#B0B7C3" }} />
          </Box>
        )}

        {messages.length === 0 ? (
          <Box
            sx={{
              height: "100%",
              minHeight: 260,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              py: 6,
              gap: 2,
            }}
          >
            <Box
              sx={{
                width: isMobile ? 56 : 64,
                height: isMobile ? 56 : 64,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#F3F4F6",
                color: "#9CA3AF",
              }}
            >
              <svg
                width={isMobile ? 28 : 32}
                height={isMobile ? 28 : 32}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </Box>
            <Typography
              sx={{
                fontSize: isMobile ? 14 : 15,
                color: "#6B7280",
                textAlign: "center",
                fontWeight: 500,
              }}
            >
              Aucun message pour le moment
            </Typography>
            <Typography
              sx={{
                fontSize: isMobile ? 12 : 13,
                color: "#9CA3AF",
                textAlign: "center",
                maxWidth: 280,
              }}
            >
              Commencez la conversation en envoyant un message
            </Typography>
          </Box>
        ) : (
          messages.map((message, index) => {
            const previousMessage = messages[index - 1];
            const showDivider = shouldShowDateDivider(message, previousMessage);

            return (
              <Box key={message.id}>
                {showDivider && (
                  <MessagesDateDivider label={formatDateLabel(message.date)} />
                )}

                <MessageBubble
                  message={message}
                  conversation={currentConversation}
                />
              </Box>
            );
          })
        )}

        {isRemoteTyping && (
          <Typography
            sx={{
              mt: 1.25,
              mb: 0.25,
              fontStyle: "italic",
              color: "#B0B7C3",
              fontSize: isMobile ? 12 : 13,
              pl: 0.5,
              fontWeight: 500,
            }}
          >
            {`••• ${currentConversation?.name} est en train d\u2019écrire ...`}
          </Typography>
        )}

        <div ref={messagesBottomRef} />
      </Box>

      <Box
        sx={{
          flexShrink: 0,
          px: { xs: 1, md: 2 },
          pt: { xs: 0.75, md: 1 },
          pb: isMedium ? 1.5 : { xs: 1.5, md: 0.75 },
          borderTop: "1px solid #F2F4F7",
          backgroundColor: isCommunicationConfirmed ? "#FFFFFF" : "#FCFCFD",
          position: "relative",
          zIndex: 5,
        }}
      >
        {!isCommunicationConfirmed && (
          <Typography
            sx={{
              mb: 1,
              fontSize: 13,
              color: "#98A2B3",
              fontWeight: 500,
            }}
          >
            Choisissez d&apos;abord un mode de communication pour pouvoir
            écrire.
          </Typography>
        )}

        {/* Upload Progress Bar */}
        {isUploading && (
          <Box sx={{ mb: 1.5 }}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                mb: 0.5,
              }}
            >
              <Typography
                sx={{
                  fontSize: 12,
                  color: theme.palette.primary.main,
                  fontWeight: 600,
                }}
              >
                Téléchargement en cours...
              </Typography>
              <Typography
                sx={{
                  fontSize: 12,
                  color: theme.palette.text.secondary,
                  fontWeight: 600,
                }}
              >
                {uploadProgress}%
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={uploadProgress}
              sx={{
                height: 6,
                borderRadius: 3,
                backgroundColor: theme.palette.grey[200],
                "& .MuiLinearProgress-bar": {
                  borderRadius: 3,
                  backgroundColor: theme.palette.primary.main,
                },
              }}
            />
          </Box>
        )}

        <MessageInput
          value={inputValue}
          onChange={handleInputChange}
          onSend={handleSendMessage}
          requests={messageRequests}
          disabled={!isCommunicationConfirmed || isUploading}
          recipientType={recipientType}
          recipientId={recipientId}
          isGroup={conversation?.isGroup}
          onFocus={onMarkAsRead}
        />
      </Box>
    </Box>
  );
}
