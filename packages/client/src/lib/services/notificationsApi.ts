import { createApi } from "@reduxjs/toolkit/query/react";
import { baseQueryWithReauth } from "./baseQueryWithReauth";
import {
  acquireNotificationsSocket,
  releaseNotificationsSocket,
} from "../notificationsSocket";

export interface NotificationDto {
  id: number;
  recipientId: number;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
  updatedAt?: string;
  actorPhotoUrl?: string | null;
}

export interface GetNotificationsResponse {
  notifications: NotificationDto[];
  total: number;
  unreadCount: number;
}

export const notificationsApi = createApi({
  reducerPath: "notificationsApi",
  baseQuery: baseQueryWithReauth,
  tagTypes: ["Notifications"],
  endpoints: (builder) => ({
    getNotifications: builder.query<
      GetNotificationsResponse,
      { limit?: number; offset?: number } | void
    >({
      query: (params) => {
        const safeParams = params ?? {};
        const search = new URLSearchParams();
        if (safeParams.limit != null)
          search.set("limit", String(safeParams.limit));
        if (safeParams.offset != null)
          search.set("offset", String(safeParams.offset));
        const qs = search.toString();
        return {
          url: `/notifications${qs ? `?${qs}` : ""}`,
          method: "GET",
        };
      },
      providesTags: [{ type: "Notifications", id: "LIST" }],
      async onCacheEntryAdded(
        _arg,
        { cacheDataLoaded, cacheEntryRemoved, updateCachedData, dispatch },
      ) {
        await cacheDataLoaded;

        if (!localStorage.getItem("token")) {
          await cacheEntryRemoved;
          return;
        }

        const socket = acquireNotificationsSocket();

        const onNotification = (payload: any) => {
          if (!payload || payload.id == null) return;
          // Refetch list from API so UI always matches DB (avoids stale RTK draft edge cases).
          dispatch(
            notificationsApi.util.invalidateTags([
              { type: "Notifications", id: "LIST" },
              { type: "Notifications", id: "UNREAD_COUNT" },
            ]),
          );
        };

        const onNotificationUpdate = (payload: any) => {
          if (!payload) return;
          updateCachedData((draft) => {
            if (!draft?.notifications) return;
            if (payload.allRead) {
              draft.notifications = draft.notifications.map((n) => ({
                ...n,
                read: true,
              }));
              draft.unreadCount = 0;
              return;
            }
            if (payload.notificationId != null) {
              const target = draft.notifications.find(
                (n) => String(n.id) === String(payload.notificationId),
              );
              if (target) target.read = !!payload.read;
              draft.unreadCount = draft.notifications.filter(
                (n) => !n.read,
              ).length;
            }
          });
        };

        socket.on("notification", onNotification);
        socket.on("notificationUpdate", onNotificationUpdate);

        await cacheEntryRemoved;
        socket.off("notification", onNotification);
        socket.off("notificationUpdate", onNotificationUpdate);
        releaseNotificationsSocket();
      },
    }),

    getUnreadNotificationsCount: builder.query<{ unreadCount: number }, void>({
      query: () => ({
        url: "/notifications/unread-count",
        method: "GET",
      }),
      providesTags: [{ type: "Notifications", id: "UNREAD_COUNT" }],
    }),

    markNotificationAsRead: builder.mutation<unknown, number>({
      query: (id) => ({
        url: `/notifications/${id}/read`,
        method: "PATCH",
        skipToast: true,
      }),
      invalidatesTags: [
        { type: "Notifications", id: "LIST" },
        { type: "Notifications", id: "UNREAD_COUNT" },
      ],
    }),

    markAllNotificationsAsRead: builder.mutation<unknown, void>({
      query: () => ({
        url: "/notifications/mark-all-read",
        method: "POST",
      }),
      invalidatesTags: [
        { type: "Notifications", id: "LIST" },
        { type: "Notifications", id: "UNREAD_COUNT" },
      ],
    }),
  }),
});

export const {
  useGetNotificationsQuery,
  useGetUnreadNotificationsCountQuery,
  useMarkNotificationAsReadMutation,
  useMarkAllNotificationsAsReadMutation,
} = notificationsApi;
