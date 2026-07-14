export type ConversationCategory =
  | "client"
  | "collaborateur"
  | "comptable"
  | "group";

export type GroupMember = {
  id: number;
  name: string;
  role: "client" | "collaborateur" | "comptable";
  avatar: string;
};

export type Conversation = {
  id: number;
  name: string;
  role: string;
  preview: string;
  fullDate: string | null;
  time?: string;
  avatar: string;
  avatarColor: string;
  avatarTextColor: string;
  online: boolean;
  unreadCount: number;
  phone: string;
  category: ConversationCategory;
  // Group-specific fields
  isGroup?: boolean;
  members?: GroupMember[];
  memberCount?: number;
  createdBy?: number;
  // 1:1-specific fields
  participantId?: number;
};

export type MessageFile = {
  name: string;
  size: string;
  type: string;
  url: string;
};

export type MessageRequest = {
  id: number;
  title: string;
  subtitle: string;
  dateLabel?: string;
  status?: string;
  urgency?: string;
};

export type MessageTask = {
  id: number;
  title: string;
  status: string;
  priority: string;
};

export type MessageAppointment = {
  id: number;
  title: string;
  startTime: string;
  endTime: string;
  status: string;
  type: string;
};

export type MessageCall = {
  id: number;
  callType: "audio" | "video";
  status: "missed" | "completed" | "rejected" | "cancelled" | "ongoing";
  duration?: number;
  initiatorId: number;
  /** True when the current user is the one who placed this call (derived from
   * call.initiatorId, not ChatMessage.senderId — the two happen to always
   * match today, but this keeps the UI correct even if that changes). */
  isOutgoing: boolean;
};

export type Message = {
  id: number;
  type: "text" | "file" | "request" | "task" | "appointment" | "call";
  text?: string;
  html?: string;
  file?: MessageFile;
  request?: MessageRequest;
  task?: MessageTask;
  appointment?: MessageAppointment;
  call?: MessageCall;
  mine: boolean;
  large?: boolean;
  time?: string;
  date: string;
  // For group messages
  senderName?: string;
  senderAvatar?: string;
};

export type SharedMediaFile = {
  id: number;
  name: string;
  type: "pdf" | "image" | "doc" | "xls" | "file";
  size: string;
  uploadedAt: string;
  previewUrl?: string;
};
