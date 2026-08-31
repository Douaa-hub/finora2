import { useEffect, useMemo, useRef } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "src/lib/store";
import {
  useGetUserRoomsQuery,
  useGetRoomMessagesQuery,
  useSendMessageMutation,
  useMarkAsReadMutation,
  type ChatRoom,
  type ChatMessage,
  type GetRoomsParams,
  type GetRoomsResponse,
} from "src/lib/services/chatApi";
import type {
  Conversation,
  ConversationCategory,
  GroupMember,
  Message,
} from "../data/types";

// Inline role helpers (mirrors index.tsx — kept local to avoid circular imports)
function isComptableRole(code: string): boolean {
  return (
    code === "comptable" ||
    code === "accountant" ||
    code.includes("comptable") ||
    code.includes("accountant")
  );
}

/**
 * Returns the date string only if it represents a real activity date.
 * Rejects null/undefined AND the Unix epoch (new Date(0)) that the backend
 * uses as a sentinel value for virtual rooms with no activity.
 */
function toActivityDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const ts = new Date(d).getTime();
  if (!ts || ts <= 0) return null; // epoch sentinel → no date
  return d;
}

function mapRoomToConversation(
  room: ChatRoom,
  currentUserId: number,
): Conversation {
  // ── Group rooms ───────────────────────────────────────────────────────────
  if (room.type === "group") {
    const groupProfiles = room.participantProfiles ?? [];
    const groupName = room.name || "Groupe";
    const groupAvatar = groupName
      .split(" ")
      .map((w) => w[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2)
      .toUpperCase();

    const members: GroupMember[] = groupProfiles
      .filter((p) => Number(p.id) !== currentUserId)
      .map((p) => {
        const fullName =
          [p.firstName, p.lastName].filter(Boolean).join(" ") ||
          p.username ||
          p.email ||
          "?";

        const rawCode = p.role?.code ?? "";
        const roleCode = rawCode.toUpperCase();

        let memberRole: "client" | "collaborateur" | "comptable";
        if (roleCode === "CLIENT" || roleCode.startsWith("CLIENT_")) {
          memberRole = "client";
        } else if (roleCode === "ACCOUNTANT" || roleCode === "COMPTABLE") {
          memberRole = "comptable";
        } else if (
          roleCode === "COLLABORATOR" ||
          roleCode === "COLLABORATEUR"
        ) {
          memberRole = "collaborateur";
        } else {
          memberRole = "collaborateur";
        }

        return {
          id: Number(p.id),
          name: fullName,
          role: memberRole,
          avatar: fullName
            .split(" ")
            .map((w) => w[0])
            .filter(Boolean)
            .join("")
            .slice(0, 2)
            .toUpperCase(),
        };
      });

    let groupPreview = "";
    if (room.lastMessage) {
      const lm = room.lastMessage;
      const isOwn = Number(lm.senderId) === currentUserId;
      let body: string;
      if (lm.type === "file" || lm.type === "image") {
        const fileName = lm.content?.split("/").pop() || "fichier";
        body = `📎 ${fileName}`;
      } else if (lm.type === "call") {
        body = `📞 ${lm.content}`;
      } else {
        body = lm.content || "";
      }
      if (isOwn) {
        groupPreview = `Vous : ${body}`;
      } else {
        const senderProfile = groupProfiles.find(
          (p) => Number(p.id) === Number(lm.senderId),
        );
        const senderName = senderProfile
          ? [senderProfile.firstName, senderProfile.lastName]
              .filter(Boolean)
              .join(" ") ||
            senderProfile.username ||
            ""
          : "";
        groupPreview = senderName ? `${senderName} : ${body}` : body;
      }
    }

    // lastActivity = date of last message; lastMessage.createdAt = fallback from
    // the embedded last-message object. Never use updatedAt: it reflects DB record
    // changes (migrations, seeding) and not actual conversation activity.
    const groupLastDate =
      toActivityDate(room.lastActivity) ??
      toActivityDate(room.lastMessage?.createdAt) ??
      null;

    return {
      id: room.id,
      name: groupName,
      role: `${members.length} membres`,
      preview: groupPreview,
      fullDate: groupLastDate,
      time: groupLastDate
        ? new Date(groupLastDate).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : undefined,
      avatar: groupAvatar,
      avatarColor: "#3B82F6",
      avatarTextColor: "#FFFFFF",
      online: false,
      unreadCount: room.unreadCount ?? 0,
      phone: "",
      category: "group",
      isGroup: true,
      members,
      memberCount: members.length,
    };
  }

  // ── Direct / other rooms (unchanged) ─────────────────────────────────────
  const profiles = room.participantProfiles ?? [];
  const other =
    profiles.find((p) => Number(p.id) !== currentUserId) ?? profiles[0] ?? null;

  // Normalise role code to the correct ConversationCategory.
  // CLIENT → "client"
  // ACCOUNTANT/COMPTABLE → "comptable"
  // COLLABORATOR/COLLABORATEUR → "collaborateur"
  const otherRoleCode = (other?.role?.code ?? "").toLowerCase();
  const category: ConversationCategory =
    otherRoleCode === "client" || otherRoleCode.startsWith("client_")
      ? "client"
      : isComptableRole(otherRoleCode)
        ? "comptable"
        : "collaborateur";

  let name: string;
  let role: string;
  let avatar: string;

  if (other) {
    const fullName =
      [other.firstName, other.lastName].filter(Boolean).join(" ") ||
      other.username ||
      other.email;
    name = fullName;
    // For clients, show company name instead of role
    if (category === "client") {
      role = other.company?.name ?? other.role?.nameFr ?? "";
    } else {
      role = other.role?.nameFr ?? "";
    }
    avatar = fullName
      .split(" ")
      .map((w) => w[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2)
      .toUpperCase();
  } else {
    name = room.name || "Conversation";
    role = room.type;
    avatar = (room.name || "??")
      .split(" ")
      .map((w) => w[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  let preview = "";
  if (room.lastMessage) {
    const lm = room.lastMessage;
    const isOwn = Number(lm.senderId) === currentUserId;
    let body: string;
    if (lm.type === "file" || lm.type === "image") {
      const fileName = lm.content?.split("/").pop() || "fichier";
      body = `📎 ${fileName}`;
    } else if (lm.type === "call") {
      body = `📞 ${lm.content}`;
    } else {
      body = lm.content || "";
    }
    preview = isOwn ? `Vous : ${body}` : body;
  }

  const lastDate =
    toActivityDate(room.lastActivity) ??
    toActivityDate(room.lastMessage?.createdAt) ??
    null;

  return {
    id: room.id,
    name,
    role,
    preview,
    fullDate: lastDate,
    time: lastDate
      ? new Date(lastDate).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : undefined,
    avatar,
    avatarColor: "#D9D9D9",
    avatarTextColor: "#666666",
    online: false,
    unreadCount: room.unreadCount ?? 0,
    phone: "",
    category,
    participantId: other ? Number(other.id) : undefined,
  };
}

const REQUEST_TYPE_LABELS: Record<string, string> = {
  accounting: "Comptabilité",
  tax: "Fiscalité",
  consultation: "Consultation",
  document: "Document",
  other: "Autre",
};

const REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: "En attente",
  in_progress: "En cours",
  resolved: "Terminé",
  rejected: "Rejeté",
  cancelled: "Annulé",
};

const REQUEST_URGENCY_LABELS: Record<string, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent !",
};

export function mapApiMessageToMessage(
  msg: ChatMessage,
  currentUserId: number,
): Message {
  const date = new Date(msg.createdAt).toISOString().split("T")[0];
  const time = new Date(msg.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const isMine = msg.senderId === currentUserId;

  // Derive sender display name from the nested sender object (present in group rooms)
  const senderName = msg.sender
    ? [msg.sender.firstName, msg.sender.lastName].filter(Boolean).join(" ") ||
      msg.sender.username ||
      ""
    : "";
  const senderAvatar = senderName
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();

  if (msg.request) {
    return {
      id: msg.id,
      type: "request" as const,
      text: msg.content,
      html: msg.content,
      mine: isMine,
      time,
      date,
      senderName: isMine ? undefined : senderName || undefined,
      senderAvatar: isMine ? undefined : senderAvatar || undefined,
      request: {
        id: msg.request.id,
        title: msg.request.subject,
        subtitle: REQUEST_TYPE_LABELS[msg.request.type] || msg.request.type,
        status: REQUEST_STATUS_LABELS[msg.request.status] || msg.request.status,
        urgency:
          REQUEST_URGENCY_LABELS[msg.request.urgency] || msg.request.urgency,
      },
    };
  }

  if (msg.task) {
    return {
      id: msg.id,
      type: "task" as const,
      text: msg.content,
      html: msg.content,
      mine: isMine,
      time,
      date,
      senderName: isMine ? undefined : senderName || undefined,
      senderAvatar: isMine ? undefined : senderAvatar || undefined,
      task: {
        id: msg.task.id,
        title: msg.task.title,
        status: msg.task.status,
        priority: msg.task.priority,
      },
    };
  }

  if (msg.appointment) {
    return {
      id: msg.id,
      type: "appointment" as const,
      text: msg.content,
      html: msg.content,
      mine: isMine,
      time,
      date,
      senderName: isMine ? undefined : senderName || undefined,
      senderAvatar: isMine ? undefined : senderAvatar || undefined,
      appointment: {
        id: msg.appointment.id,
        title: msg.appointment.title,
        startTime: msg.appointment.startTime,
        endTime: msg.appointment.endTime,
        status: msg.appointment.status,
        type: msg.appointment.type,
      },
    };
  }

  if (msg.call) {
    return {
      id: msg.id,
      type: "call" as const,
      text: msg.content,
      html: msg.content,
      mine: isMine,
      time,
      date,
      senderName: isMine ? undefined : senderName || undefined,
      senderAvatar: isMine ? undefined : senderAvatar || undefined,
      call: {
        id: msg.call.id,
        callType: msg.call.callType as "audio" | "video",
        status: msg.call.status as
          | "missed"
          | "completed"
          | "rejected"
          | "cancelled",
        duration: msg.call.duration,
        initiatorId: msg.call.initiatorId,
        isOutgoing: msg.call.initiatorId === currentUserId,
      },
    };
  }

  if (msg.type === "file" || msg.type === "image") {
    // content = user's message text (can be empty if no text was provided)
    // fileName = actual file object name/path from backend
    // fileUrl = presigned URL from backend for the actual file
    const url = msg.fileUrl || "";
    const objectName = (msg as any).fileName || msg.content || "";
    const rawFileName = objectName.split("/").pop() || objectName || "Fichier";
    // sendMessage() always prefixes the stored object name with
    // `${Date.now()}-` to avoid collisions in MinIO — strip it so the card
    // shows the real original filename instead of a timestamp-cluttered one.
    const fileName = rawFileName.replace(/^\d+-/, "") || "Fichier";
    // Derive category: trust server type hint ("image") first, then filename extension
    const lower = fileName.toLowerCase();
    const fileCategory =
      msg.type === "image" || /\.(png|jpe?g|webp|gif|bmp|svg)$/.test(lower)
        ? "image"
        : lower.endsWith(".pdf")
          ? "pdf"
          : /\.docx?$/.test(lower)
            ? "doc"
            : /\.(xlsx?|csv)$/.test(lower)
              ? "xls"
              : "file";
    return {
      id: msg.id,
      type: "file" as const,
      text: msg.content || "", // User's text message (empty if they didn't provide text)
      html: msg.content || "",
      mine: isMine,
      time,
      date,
      senderName: isMine ? undefined : senderName || undefined,
      senderAvatar: isMine ? undefined : senderAvatar || undefined,
      file: { name: fileName, size: "", type: fileCategory, url },
    };
  }

  return {
    id: msg.id,
    type: "text" as const,
    text: msg.content,
    mine: isMine,
    time,
    date,
    senderName: isMine ? undefined : senderName || undefined,
    senderAvatar: isMine ? undefined : senderAvatar || undefined,
  };
}

export function useConversations(params?: GetRoomsParams) {
  const currentUserId = useSelector((state: RootState) => state.auth.user?.id);
  const uid = currentUserId ? Number(currentUserId) : 0;

  // getUserRooms returns GetRoomsResponse: { data: ChatRoom[], total, page, pageSize, totalPages }
  const {
    data: roomsResponse,
    isLoading,
    isFetching,
    isError,
    error,
  } = useGetUserRoomsQuery(params, {
    refetchOnMountOrArgChange: true,
    // No polling — real-time updates handled by WebSocket
  });

  // Keep the last successfully fetched page for the CURRENT params around, so
  // a transient refetch or an aborted in-flight request (roomsResponse
  // momentarily undefined) never blanks the list — only a genuinely
  // different set of params resets it. Updated from an effect (not during
  // render) so we never mutate a ref based on a render that could be thrown
  // away (e.g. StrictMode's double-invoke).
  const paramsKey = JSON.stringify(params ?? null);
  const lastGoodRef = useRef<{ key: string; response: GetRoomsResponse } | null>(
    null,
  );

  useEffect(() => {
    if (roomsResponse) {
      lastGoodRef.current = { key: paramsKey, response: roomsResponse };
    }
  }, [paramsKey, roomsResponse]);

  const effectiveResponse =
    roomsResponse ??
    (lastGoodRef.current?.key === paramsKey
      ? lastGoodRef.current.response
      : undefined);

  // True once we have a confirmed (possibly slightly stale) result for these
  // exact params — lets callers tell "still loading, nothing yet" apart from
  // "we know what this list looks like".
  const hasData = effectiveResponse !== undefined;

  // Extract the array — roomsResponse is the paginated object, not the array itself
  const rooms: ChatRoom[] = effectiveResponse?.data ?? [];

  const conversations = useMemo(
    () => rooms.map((room) => mapRoomToConversation(room, uid)),
    [rooms, uid],
  );

  return {
    conversations,
    rooms,
    roomsResponse: effectiveResponse,
    isLoading,
    isFetching,
    isError,
    error,
    hasData,
  };
}

export function useRoomMessages(roomId: number, page: number, limit: number) {
  const currentUserId = useSelector((state: RootState) => state.auth.user?.id);
  const uid = currentUserId ? Number(currentUserId) : 0;

  const { data, isLoading, isFetching, error } = useGetRoomMessagesQuery(
    { roomId, page, limit },
    {
      skip: !roomId,
      refetchOnMountOrArgChange: true,
    },
  );

  const messages = useMemo(() => {
    const raw = data?.messages ?? [];
    // CRITICAL: filter strictly by roomId to prevent stale cache from a
    // previously selected room from leaking into the current conversation.
    const filtered = raw.filter((msg) => Number(msg.roomId) === Number(roomId));
    return filtered.map((msg) => mapApiMessageToMessage(msg, uid));
  }, [data, uid, roomId]);

  return {
    messages,
    isLoading,
    isFetching,
    error,
    totalMessages: data?.total ?? 0,
    totalPages: data?.totalPages ?? 1,
  };
}

export { useSendMessageMutation, useMarkAsReadMutation };
export { mapRoomToConversation };
