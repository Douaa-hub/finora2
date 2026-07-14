import { createApi } from "@reduxjs/toolkit/query/react";
import { baseQueryWithReauth } from "./baseQueryWithReauth";
import { io } from "socket.io-client";

// ==================== TYPES ====================

export interface ChatParticipant {
  id: number;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

export interface ChatRoomParticipantProfile {
  id: number;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  email: string;
  company?: { id: number; name: string } | null;
  role?: { nameFr: string; code?: string } | null;
}

export interface ChatRoom {
  id: number;
  name?: string | null;
  type: string;
  description?: string | null;
  participants: string[];
  admins?: string[];
  status: string;
  lastActivity?: string;
  lastMessageId?: number;
  lastMessage?: {
    id: number;
    roomId: number;
    content: string;
    type: string;
    senderId: number;
    createdAt: string;
    attachments?: string[];
  } | null;
  participantProfiles?: ChatRoomParticipantProfile[];
  createdAt?: string;
  updatedAt?: string;
  createdBy?: ChatParticipant;
  unreadCount?: number;
}

export interface ChatMessageRequest {
  id: number;
  subject: string;
  type: string;
  status: string;
  urgency: string;
}

export interface ChatMessageTask {
  id: number;
  title: string;
  status: string;
  priority: string;
}

export interface ChatMessageAppointment {
  id: number;
  title: string;
  startTime: string;
  endTime: string;
  status: string;
  type: string;
}

export interface ChatMessageCall {
  id: number;
  callType: string;
  status: string;
  duration?: number;
  initiatorId: number;
}

export interface ChatMessage {
  id: number;
  roomId: number;
  threadId?: number;
  senderId: number;
  content: string;
  type: string;
  mentions?: string[];
  documentId?: number;
  requestId?: number;
  taskId?: number;
  appointmentId?: number;
  callId?: number;
  readBy?: string[];
  deleted: boolean;
  edited: boolean;
  createdAt: string;
  updatedAt?: string;
  sender?: ChatParticipant;
  attachments?: string[];
  fileUrl?: string | null;
  fileName?: string | null;
  request?: ChatMessageRequest;
  task?: ChatMessageTask;
  appointment?: ChatMessageAppointment;
  call?: ChatMessageCall;
}

export interface GetRoomsResponse {
  data: ChatRoom[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface GetRoomsParams {
  /** Array of role codes to filter by (OR logic) */
  categories?: string[];
  /** Legacy single category support (deprecated) */
  category?: string;
  /** Search term for participant names and messages */
  search?: string;
  /** Filter by date (YYYY-MM-DD) */
  date?: string;
  /** Show only unread conversations */
  unreadOnly?: boolean;
  /** Page number for pagination */
  page?: number;
  /** Number of results per page */
  pageSize?: number;
}

export interface GetRoomMessagesResponse {
  messages: ChatMessage[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CreateRoomInput {
  name?: string;
  type: string;
  description?: string;
  participants: number[];
  contextId?: number;
  contextType?: string;
}

export interface SendMessageInput {
  roomId: number;
  content: string;
  type?: string;
  threadId?: number;
  mentions?: number[];
  documentId?: number;
  requestId?: number;
  taskId?: number;
  appointmentId?: number;
  attachments?: File[];
}

export interface RecentMessage {
  id: number;
  roomId: number;
  senderId: number;
  content: string;
  type: string;
  createdAt: string;
  unread: boolean;
  sender: {
    id: number;
    firstName?: string;
    lastName?: string;
    username?: string;
  };
  room: {
    id: number;
    name?: string;
    type?: string;
    category: string;
  };
  fileUrl?: string | null;
  request?: { id: number; subject: string } | null;
  task?: { id: number; title: string } | null;
  appointment?: { id: number; title: string } | null;
}

export interface RecentMessagesResponse {
  messages: RecentMessage[];
  unreadCount: number;
}

export interface SharedDocument {
  id: number;
  roomId: number;
  senderId: number;
  content: string;
  type: string;
  createdAt: string;
  documentId: number | null;
  fileUrl: string | null;
}

export interface GetSharedDocumentsResponse {
  data: SharedDocument[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface GetSharedDocumentsParams {
  roomId: number;
  page?: number;
  pageSize?: number;
}

export interface UserRequest {
  id: number;
  subject: string;
  type: string;
  urgency: string;
  status: string;
  createdAt: string;
}

export interface GetUserRequestsResponse {
  success: boolean;
  data: UserRequest[];
}

// ==================== API ====================

export const chatApi = createApi({
  reducerPath: "chatApi",
  baseQuery: baseQueryWithReauth,
  tagTypes: ["ChatRooms", "ChatMessages"],
  endpoints: (builder) => ({
    // Returns paginated { data: ChatRoom[], total, page, pageSize, totalPages }
    getUserRooms: builder.query<GetRoomsResponse, GetRoomsParams | undefined>({
      query: (params) => {
        const qs = new URLSearchParams();
        if (params?.categories && params.categories.length > 0) {
          params.categories.forEach((cat) => qs.append("categories", cat));
        }
        if (params?.category) qs.set("category", params.category);
        if (params?.search) qs.set("search", params.search);
        if (params?.date) qs.set("date", params.date);
        if (params?.unreadOnly) qs.set("unreadOnly", "true");
        if (params?.page !== undefined) qs.set("page", String(params.page));
        if (params?.pageSize !== undefined)
          qs.set("pageSize", String(params.pageSize));
        const queryString = qs.toString();
        return {
          url: `/chat/rooms${queryString ? `?${queryString}` : ""}`,
          method: "GET",
        };
      },
      providesTags: [{ type: "ChatRooms", id: "LIST" }],
      keepUnusedDataFor: 0,
    }),

    getRoomById: builder.query<ChatRoom, number>({
      query: (id) => ({ url: `/chat/rooms/${id}`, method: "GET" }),
      providesTags: (_result, _err, id) => [{ type: "ChatRooms", id }],
    }),

    createRoom: builder.mutation<ChatRoom, CreateRoomInput>({
      query: (body) => ({ url: "/chat/rooms", method: "POST", body }),
      invalidatesTags: [{ type: "ChatRooms", id: "LIST" }],
    }),

    findOrCreateDirectRoom: builder.mutation<
      ChatRoom,
      { targetUserId: number }
    >({
      query: ({ targetUserId }) => ({
        url: "/chat/rooms/direct",
        method: "POST",
        body: { targetUserId },
      }),
      invalidatesTags: [{ type: "ChatRooms", id: "LIST" }],
    }),

    updateRoom: builder.mutation<ChatRoom, { roomId: number; name?: string }>({
      query: ({ roomId, name }) => ({
        url: `/chat/rooms/${roomId}`,
        method: "PATCH",
        body: { name },
      }),
      invalidatesTags: (_result, _err, { roomId }) => [
        { type: "ChatRooms", id: roomId },
        { type: "ChatRooms", id: "LIST" },
      ],
    }),

    addParticipant: builder.mutation<
      { message: string },
      { roomId: number; participantId: number }
    >({
      query: ({ roomId, participantId }) => ({
        url: `/chat/rooms/${roomId}/participants`,
        method: "POST",
        body: { participantId },
      }),
      invalidatesTags: (_result, _err, { roomId }) => [
        { type: "ChatRooms", id: roomId },
      ],
    }),

    removeParticipant: builder.mutation<
      { message: string },
      { roomId: number; participantId: number }
    >({
      query: ({ roomId, participantId }) => ({
        url: `/chat/rooms/${roomId}/participants/${participantId}`,
        method: "DELETE",
      }),
      invalidatesTags: (_result, _err, { roomId }) => [
        { type: "ChatRooms", id: roomId },
      ],
    }),

    getRoomMessages: builder.query<
      GetRoomMessagesResponse,
      { roomId: number; page: number; limit: number }
    >({
      query: ({ roomId, page, limit }) => ({
        url: `/chat/rooms/${roomId}/messages?page=${page}&limit=${limit}`,
        method: "GET",
      }),
      providesTags: (_result, _err, { roomId }) => [
        { type: "ChatMessages", id: roomId },
      ],
      keepUnusedDataFor: 0,
    }),

    sendMessage: builder.mutation<ChatMessage, SendMessageInput>({
      query: ({ attachments, ...rest }) => {
        if (attachments && attachments.length > 0) {
          const formData = new FormData();
          formData.append("roomId", String(rest.roomId));
          formData.append("content", rest.content);
          formData.append("type", rest.type ?? "text");
          if (rest.threadId) formData.append("threadId", String(rest.threadId));
          if (rest.mentions?.length)
            formData.append("mentions", rest.mentions.join(","));
          if (rest.documentId)
            formData.append("documentId", String(rest.documentId));
          if (rest.requestId)
            formData.append("requestId", String(rest.requestId));
          if (rest.taskId) formData.append("taskId", String(rest.taskId));
          if (rest.appointmentId)
            formData.append("appointmentId", String(rest.appointmentId));
          attachments.forEach((file) => formData.append("attachments", file));
          return { url: "/chat/messages", method: "POST", body: formData };
        }
        return { url: "/chat/messages", method: "POST", body: rest };
      },
      // No invalidation — messages are managed locally to avoid refetch wiping optimistic state
    }),

    sendFileMessage: builder.mutation<
      ChatMessage,
      { roomId: number; file: File }
    >({
      query: ({ roomId, file }) => {
        const body = new FormData();
        body.append("roomId", String(roomId));
        body.append("type", "file");
        body.append("content", file.name);
        body.append("attachments", file);
        return { url: "/chat/messages", method: "POST", body };
      },
    }),

    markAsRead: builder.mutation<void, number>({
      query: (messageId) => ({
        url: `/chat/messages/${messageId}/read`,
        method: "POST",
      }),
    }),

    markRoomAsRead: builder.mutation<{ success: boolean }, number>({
      query: (roomId) => ({
        url: `/chat/rooms/${roomId}/read`,
        method: "POST",
      }),
      async onQueryStarted(roomId, { dispatch, queryFulfilled }) {
        // Optimistically update recent messages cache
        const patchResult = dispatch(
          chatApi.util.updateQueryData(
            "getRecentMessages",
            undefined,
            (draft) => {
              if (!draft) return;

              // Mark all messages from this room as read
              let hasChanges = false;
              draft.messages.forEach((msg) => {
                if (msg.roomId === roomId && msg.unread) {
                  msg.unread = false;
                  hasChanges = true;
                }
              });

              // Recalculate unread count if any changes were made
              if (hasChanges) {
                draft.unreadCount = draft.messages.filter(
                  (m) => m.unread,
                ).length;
              }
            },
          ),
        );

        try {
          await queryFulfilled;
        } catch {
          patchResult.undo();
        }
      },
      invalidatesTags: [
        { type: "ChatRooms", id: "LIST" },
        { type: "ChatMessages", id: "RECENT" },
        { type: "ChatMessages", id: "UNREAD_COUNT" },
      ],
    }),

    getRecentMessages: builder.query<RecentMessagesResponse, void>({
      query: () => ({
        url: "/chat/messages/recent",
        method: "GET",
      }),
      providesTags: [{ type: "ChatMessages", id: "RECENT" }],
      keepUnusedDataFor: 300,
      async onCacheEntryAdded(
        _arg,
        {
          cacheDataLoaded,
          cacheEntryRemoved,
          updateCachedData,
          dispatch,
          getState,
        },
      ) {
        await cacheDataLoaded;

        const token = localStorage.getItem("token");
        const apiUrl = import.meta.env.VITE_API_URL ?? "";
        if (!token || !apiUrl) return;

        const origin = new URL(apiUrl).origin;
        const socket = io(origin, {
          auth: { token },
          transports: ["websocket", "polling"],
          reconnection: true,
        });

        const onNewMessage = (payload: any) => {
          if (!payload || payload.id == null) return;

          // Get current user ID from auth state
          const state = getState() as any;
          const currentUserId = state?.auth?.user?.id;

          // Skip messages sent by current user (only show received messages)
          if (payload.senderId === currentUserId) return;

          updateCachedData((draft) => {
            // Check if message already exists
            const exists = draft.messages.some(
              (m) => String(m.id) === String(payload.id),
            );
            if (exists) return;

            // Message is always unread since we only show received messages
            const isUnread = !(payload.readBy ?? []).includes(
              String(currentUserId),
            );

            // Prepend new message
            const newMessage: RecentMessage = {
              id: Number(payload.id),
              roomId: Number(payload.roomId),
              senderId: Number(payload.senderId),
              content: String(payload.content ?? ""),
              type: String(payload.type ?? "text"),
              createdAt: String(payload.createdAt ?? new Date().toISOString()),
              unread: isUnread,
              sender: payload.sender ?? { id: payload.senderId },
              room: payload.room ?? { id: payload.roomId, category: "client" },
              fileUrl: payload.fileUrl ?? null,
              request: payload.request ?? null,
              task: payload.task ?? null,
              appointment: payload.appointment ?? null,
            };

            draft.messages.unshift(newMessage);

            // Keep only last 3 messages
            if (draft.messages.length > 3) {
              draft.messages = draft.messages.slice(0, 3);
            }

            // Increment unread count
            if (isUnread) {
              draft.unreadCount += 1;
            }
          });

          // Invalidate unread count to sync
          dispatch(
            chatApi.util.invalidateTags([
              { type: "ChatMessages", id: "UNREAD_COUNT" },
            ]),
          );
        };

        socket.on("message:new", onNewMessage);

        await cacheEntryRemoved;
        socket.off("message:new", onNewMessage);
        socket.disconnect();
      },
    }),

    getUnreadMessagesCount: builder.query<{ count: number }, void>({
      query: () => ({
        url: "/chat/messages/unread-count",
        method: "GET",
      }),
      providesTags: [{ type: "ChatMessages", id: "UNREAD_COUNT" }],
      keepUnusedDataFor: 0,
    }),

    markAllRoomsAsRead: builder.mutation<
      { success: boolean; updatedCount: number },
      void
    >({
      query: () => ({
        url: "/chat/rooms/mark-all-read",
        method: "POST",
      }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        // Optimistically mark all messages as read
        const patchResult = dispatch(
          chatApi.util.updateQueryData(
            "getRecentMessages",
            undefined,
            (draft) => {
              draft.messages.forEach((msg) => {
                msg.unread = false;
              });
              draft.unreadCount = 0;
            },
          ),
        );

        try {
          await queryFulfilled;
        } catch {
          patchResult.undo();
        }
      },
      invalidatesTags: [
        { type: "ChatRooms", id: "LIST" },
        { type: "ChatMessages", id: "RECENT" },
        { type: "ChatMessages", id: "UNREAD_COUNT" },
      ],
    }),

    editMessage: builder.mutation<
      ChatMessage,
      { messageId: number; content: string; roomId: number }
    >({
      query: ({ messageId, content }) => ({
        url: `/chat/messages/${messageId}`,
        method: "PUT",
        body: { content },
      }),
      invalidatesTags: (_result, _err, { roomId }) => [
        { type: "ChatMessages", id: roomId },
      ],
    }),

    deleteMessage: builder.mutation<
      void,
      { messageId: number; roomId: number }
    >({
      query: ({ messageId }) => ({
        url: `/chat/messages/${messageId}`,
        method: "DELETE",
      }),
      invalidatesTags: (_result, _err, { roomId }) => [
        { type: "ChatMessages", id: roomId },
      ],
    }),

    getSharedDocuments: builder.query<
      GetSharedDocumentsResponse,
      GetSharedDocumentsParams
    >({
      query: ({ roomId, page = 1, pageSize = 20 }) => ({
        url: `/chat/rooms/${roomId}/shared-documents?page=${page}&pageSize=${pageSize}`,
        method: "GET",
      }),
      providesTags: (_result, _err, { roomId }) => [
        { type: "ChatMessages", id: `shared-${roomId}` },
      ],
      keepUnusedDataFor: 0,
    }),

    getUserRequests: builder.query<
      GetUserRequestsResponse,
      { role?: string; limit?: number }
    >({
      query: ({ limit = 100 }) => ({
        url: `/requests/chat-accessible?limit=${limit}`,
        method: "GET",
      }),
      keepUnusedDataFor: 0,
    }),

    getChatAccessibleRequests: builder.query<
      {
        success: boolean;
        data: ChatMessageRequest[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      },
      { recipientId: number; page: number; limit: number }
    >({
      query: ({ recipientId, page, limit }) => ({
        url: `/requests/chat-accessible/${recipientId}?page=${page}&limit=${limit}`,
        method: "GET",
      }),
      keepUnusedDataFor: 0,
    }),

    getAllClientRequests: builder.query<
      {
        success: boolean;
        data: ChatMessageRequest[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      },
      { clientId: number; page: number; limit: number }
    >({
      query: ({ clientId, page, limit }) => ({
        url: `/requests/chat-all/${clientId}?page=${page}&limit=${limit}`,
        method: "GET",
      }),
      keepUnusedDataFor: 0,
    }),

    getChatAccessibleTasks: builder.query<
      {
        success: boolean;
        data: ChatMessageTask[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      },
      { collaboratorId: number; page: number; limit: number }
    >({
      query: ({ collaboratorId, page, limit }) => ({
        url: `/tasks/chat-accessible/${collaboratorId}?page=${page}&limit=${limit}`,
        method: "GET",
      }),
      keepUnusedDataFor: 0,
    }),

    getChatAccessibleAppointments: builder.query<
      {
        success: boolean;
        data: ChatMessageAppointment[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      },
      { clientId: number; page: number; limit: number }
    >({
      query: ({ clientId, page, limit }) => ({
        url: `/appointments/chat-accessible/${clientId}?page=${page}&limit=${limit}`,
        method: "GET",
      }),
      keepUnusedDataFor: 0,
    }),

    getMyRequests: builder.query<
      {
        success: boolean;
        data: ChatMessageRequest[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      },
      { page: number; limit: number }
    >({
      query: ({ page, limit }) => ({
        url: `/requests/my-requests?page=${page}&limit=${limit}`,
        method: "GET",
      }),
      keepUnusedDataFor: 0,
    }),

    getMyAppointments: builder.query<
      {
        success: boolean;
        data: ChatMessageAppointment[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      },
      { page: number; limit: number }
    >({
      query: ({ page, limit }) => ({
        url: `/appointments/my-appointments?page=${page}&limit=${limit}`,
        method: "GET",
      }),
      keepUnusedDataFor: 0,
    }),

    getMyTasks: builder.query<
      {
        success: boolean;
        data: ChatMessageTask[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      },
      { page: number; limit: number }
    >({
      query: ({ page, limit }) => ({
        url: `/tasks/my-tasks?page=${page}&limit=${limit}`,
        method: "GET",
      }),
      keepUnusedDataFor: 0,
    }),
  }),
});

export const {
  useGetUserRoomsQuery,
  useGetRoomByIdQuery,
  useCreateRoomMutation,
  useFindOrCreateDirectRoomMutation,
  useGetRoomMessagesQuery,
  useLazyGetRoomMessagesQuery,
  useSendMessageMutation,
  useSendFileMessageMutation,
  useMarkAsReadMutation,
  useMarkRoomAsReadMutation,
  useGetRecentMessagesQuery,
  useGetUnreadMessagesCountQuery,
  useMarkAllRoomsAsReadMutation,
  useEditMessageMutation,
  useDeleteMessageMutation,
  useUpdateRoomMutation,
  useAddParticipantMutation,
  useRemoveParticipantMutation,
  useGetSharedDocumentsQuery,
  useGetUserRequestsQuery,
  useGetChatAccessibleRequestsQuery,
  useGetAllClientRequestsQuery,
  useGetChatAccessibleTasksQuery,
  useGetChatAccessibleAppointmentsQuery,
  useGetMyRequestsQuery,
  useGetMyAppointmentsQuery,
  useGetMyTasksQuery,
} = chatApi;
