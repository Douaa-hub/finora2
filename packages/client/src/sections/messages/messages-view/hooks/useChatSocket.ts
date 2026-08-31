import { useCallback, useEffect, useRef } from "react";
import { connectSocket, getSocket } from "src/lib/socket";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SocketMessage {
  id: number;
  roomId: number;
  senderId: number;
  content: string;
  type: "text" | "file" | "image" | "system" | "call";
  createdAt: string;
  attachments?: string[];
  fileUrl?: string | null;
  sender?: {
    id: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  };
  requestId?: number | null;
  taskId?: number | null;
  appointmentId?: number | null;
  callId?: number | null;
  request?: {
    id: number;
    subject: string;
    type: string;
    status: string;
    urgency: string;
  } | null;
  task?: {
    id: number;
    title: string;
    status: string;
    priority: string;
  } | null;
  appointment?: {
    id: number;
    title: string;
    startTime: string;
    endTime: string;
    status: string;
    type: string;
  } | null;
  call?: {
    id: number;
    callType: string;
    status: string;
    duration?: number;
    initiatorId: number;
  } | null;
}

export interface TypingPayload {
  roomId: number;
  userId: number;
  typing: boolean;
}

// ── Hook options ────────────────────────────────────────────────────────────

interface UseChatSocketOptions {
  /** Current active room — rejoined automatically on every (re)connect. */
  activeRoomId?: number;
  /** Called on reconnects (not the initial connect). Use to refetch missed messages. */
  onReconnect?: () => void;
  onMessageNew?: (msg: SocketMessage) => void;
  onMessageUpdated?: (msg: SocketMessage) => void;
  onMessageDeleted?: (data: { messageId: number; roomId?: number }) => void;
  onTyping?: (data: TypingPayload) => void;
  onCallMessageUpdated?: (data: {
    messageId: number;
    roomId: number;
    callId: number;
    status: string;
    duration: number;
    content: string;
  }) => void;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useChatSocket(options: UseChatSocketOptions = {}) {
  const optsRef = useRef(options);
  optsRef.current = options;

  // Tracks whether the very first connect has happened so we can distinguish
  // initial connect from reconnects inside the onConnect handler.
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    connectSocket();
    const socket = getSocket();

    const onConnect = () => {
      const isReconnect = hasConnectedRef.current;
      hasConnectedRef.current = true;

      const roomId = optsRef.current.activeRoomId;
      if (roomId) {
        socket.emit("room:join", { roomId });
      }

      if (isReconnect) {
        optsRef.current.onReconnect?.();
      }
    };
    const onDisconnect = () => {};
    const onConnectError = (_err: Error) => {
      /* ignored */
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    const onMessageNew = (msg: SocketMessage) =>
      optsRef.current.onMessageNew?.(msg);

    const onMessageUpdated = (msg: SocketMessage) =>
      optsRef.current.onMessageUpdated?.(msg);

    const onMessageDeleted = (data: { messageId: number; roomId?: number }) =>
      optsRef.current.onMessageDeleted?.(data);

    const onTyping = (data: TypingPayload) => optsRef.current.onTyping?.(data);

    const onCallMessageUpdated = (data: {
      messageId: number;
      roomId: number;
      callId: number;
      status: string;
      duration: number;
      content: string;
    }) => {
      optsRef.current.onCallMessageUpdated?.(data);
    };

    socket.on("message:new", onMessageNew);
    socket.on("message:updated", onMessageUpdated);
    socket.on("message:deleted", onMessageDeleted);
    socket.on("user:typing", onTyping);
    socket.on("call:message-updated", onCallMessageUpdated);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("message:new", onMessageNew);
      socket.off("message:updated", onMessageUpdated);
      socket.off("message:deleted", onMessageDeleted);
      socket.off("user:typing", onTyping);
      socket.off("call:message-updated", onCallMessageUpdated);
    };
  }, []);

  // ── Emitters ────────────────────────────────────────────────────────────
  // Wrapped in useCallback with [] so their references never change between
  // renders. Without this, the join/leave useEffect in the parent would
  // re-run on every render (because joinRoom/leaveRoom would be new refs),
  // causing a constant room:leave → room:join cycle and missed messages.

  const joinRoom = useCallback((roomId: number) => {
    getSocket().emit("room:join", { roomId });
  }, []);

  const leaveRoom = useCallback((roomId: number) => {
    getSocket().emit("room:leave", { roomId });
  }, []);

  const emitTyping = useCallback((roomId: number, typing: boolean) => {
    getSocket().emit(typing ? "typing:start" : "typing:stop", { roomId });
  }, []);

  return { joinRoom, leaveRoom, emitTyping };
}
