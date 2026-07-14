import type { ButtonProps } from "@mui/material/Button";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";

import Box from "@mui/material/Box";
import List from "@mui/material/List";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import ListSubheader from "@mui/material/ListSubheader";
import CircularProgress from "@mui/material/CircularProgress";
import { useTheme, alpha } from "@mui/material/styles";
import { useDashboardBase } from "src/hooks/useDashboardBase";

import { Bell, CheckCheck } from "lucide-react";

import { Scrollbar } from "src/components/scrollbar";
import {
  useGetNotificationsQuery,
  useMarkAllNotificationsAsReadMutation,
  useMarkNotificationAsReadMutation,
} from "src/lib/services/notificationsApi";
import { useRespondToInvitationMutation } from "src/lib/services/relationshipsApi";
import { useAlert } from "src/contexts/AlertContext";

import {
  NotificationItem,
  type NotificationItemProps,
} from "./notifications-popover/NotificationItem";
import CustomButton from "src/components/common/CustomButton";
import { useNavigate } from "react-router";
import { useAppSelector } from "src/hooks/use-redux";

// ----------------------------------------------------------------------

export type NotificationsPopoverProps = ButtonProps & {
  data?: NotificationItemProps[];
};

const parseNotificationData = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
};

const readNumericId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export function NotificationsPopover({
  data = [],
  sx,
  ...other
}: NotificationsPopoverProps) {
  const theme = useTheme();
  const { showAlert } = useAlert();
  const [processingId, setProcessingId] = useState<number | null>(null);
  const {
    data: notificationsData,
    refetch: refetchNotifications,
    isLoading,
  } = useGetNotificationsQuery(
    { limit: 20, offset: 0 },
    {
      refetchOnFocus: false,
      refetchOnReconnect: false,
    },
  );
  const [markAsRead] = useMarkNotificationAsReadMutation();
  const [markAllAsRead, { isLoading: isMarkingAllAsRead }] =
    useMarkAllNotificationsAsReadMutation();
  const [respondToInvitation] = useRespondToInvitationMutation();
  const notificationAudioRef = useRef<HTMLAudioElement | null>(null);
  const seenNotificationIdsRef = useRef<Set<number>>(new Set());
  const notificationsHydratedRef = useRef(false);
  const suppressNextBeepRef = useRef(false);

  const playNotificationBeep = useCallback(() => {
    if (typeof window === "undefined") return;
    const audio = notificationAudioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return () => {};
    const audio = new Audio("/assets/sounds/notification.mp3");
    audio.preload = "auto";
    audio.volume = 1;
    notificationAudioRef.current = audio;
    return () => {
      notificationAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (notificationsData === undefined) return;

    const list = notificationsData.notifications ?? [];
    const currentIds = list
      .map((n) => Number(n.id))
      .filter((id) => Number.isFinite(id));

    if (!notificationsHydratedRef.current) {
      notificationsHydratedRef.current = true;
      seenNotificationIdsRef.current = new Set(currentIds);
      return;
    }

    if (currentIds.length === 0 && seenNotificationIdsRef.current.size > 0) {
      return;
    }

    const hasNewNotification = currentIds.some(
      (id) => !seenNotificationIdsRef.current.has(id),
    );
    if (suppressNextBeepRef.current) {
      suppressNextBeepRef.current = false;
    } else if (hasNewNotification) {
      playNotificationBeep();
    }

    seenNotificationIdsRef.current = new Set(currentIds);
  }, [notificationsData, playNotificationBeep]);

  const navigate = useNavigate();
  const dashboardBase = useDashboardBase();

  // Get user role from Redux — same pattern as NotificationsView
  const { user } = useAppSelector((state) => state.auth);
  const userRole = useMemo(() => {
    if (!user) return null;
    const roleCode =
      typeof user.role === "object" ? user.role?.code : user.role;
    if (!roleCode) return null;
    const role = String(roleCode).toLowerCase();
    if (role.includes("client")) return "client";
    if (role.includes("collaborat")) return "collaborateur";
    if (
      role.includes("accountant") ||
      role.includes("comptable") ||
      role.includes("admin")
    ) {
      return "comptable";
    }
    return null;
  }, [user]);

  // Same navigation logic as NotificationsView
  const handleNavigate = useCallback(
    (actionUrl: string) => {
      handleClosePopover();

      // Full external URL (e.g. MinIO/S3 presigned link) → open in new tab
      if (/^https?:\/\//i.test(actionUrl)) {
        window.open(actionUrl, "_blank", "noopener,noreferrer");
        return;
      }

      if (!userRole) {
        navigate(actionUrl);
        return;
      }

      // Strip any existing role prefix then rebuild the full dashboard path
      let cleanPath = actionUrl;
      const dashboardRolePattern = /^\/dashboard\/(client|comptable)/;
      if (dashboardRolePattern.test(cleanPath)) {
        cleanPath = cleanPath.replace(dashboardRolePattern, "");
      }
      if (!cleanPath.startsWith("/")) {
        cleanPath = `/${cleanPath}`;
      }
      navigate(`/dashboard/${userRole}${cleanPath}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, userRole],
  );

  const notifications = useMemo(() => {
    const source =
      notificationsData?.notifications ??
      data.map((d) => ({
        id: Number(d.id),
        type: d.type,
        title: d.title,
        message: d.description,
        read: !d.isUnRead,
        createdAt: d.postedAt,
        actionUrl: d.actionUrl,
        data: null,
      }));
    return source.map((n: any) => {
      const notificationType = String(n.type || "").toLowerCase();
      const notificationData = parseNotificationData(n.data);
      const invitationId =
        readNumericId(notificationData.invitationId) ??
        readNumericId(notificationData.relationshipId) ??
        readNumericId((n as Record<string, unknown>).invitationId);

      // Preserve the original casing of actionUrl — do NOT lowercase it
      // (presigned S3 URLs are case-sensitive)
      const rawActionUrl = String(
        (n as Record<string, unknown>).actionUrl ??
          (notificationData.actionUrl as string | undefined) ??
          "",
      );
      const actionUrl = rawActionUrl || undefined;

      const title = String(n.title ?? "").toLowerCase();
      const isInvite =
        notificationType.includes("relationship") ||
        notificationType.includes("invitation");
      const isInvitationToRespond =
        (actionUrl ?? "").includes("/relationships/invitations/") ||
        title.includes("nouvelle invitation");
      const canRespond =
        isInvite && isInvitationToRespond && !n.read && invitationId != null;

      return {
        id: String(n.id),
        type: notificationType || "notification",
        title: n.title ?? "Notification",
        isUnRead: !n.read,
        description: n.message ?? "",
        avatarUrl: null,
        postedAt: n.createdAt ?? null,
        actionUrl,
        onNavigate: handleNavigate,
        onMarkAsRead: (id: string) => {
          void markAsRead(Number(id)).catch(() => {});
        },
        canRespond,
        isProcessing: processingId === n.id,
        onAccept: canRespond
          ? async () => {
              try {
                setProcessingId(n.id);
                await respondToInvitation({
                  invitationId: invitationId as number,
                  response: "accept",
                }).unwrap();
                suppressNextBeepRef.current = true;
                await markAsRead(n.id).unwrap();
                showAlert("Invitation acceptée", "success");
                refetchNotifications();
              } catch {
                showAlert("Erreur lors de l'acceptation", "error");
              } finally {
                setProcessingId(null);
              }
            }
          : undefined,
        onReject: canRespond
          ? async () => {
              try {
                setProcessingId(n.id);
                await respondToInvitation({
                  invitationId: invitationId as number,
                  response: "reject",
                }).unwrap();
                suppressNextBeepRef.current = true;
                await markAsRead(n.id).unwrap();
                showAlert("Invitation refusée", "success");
                refetchNotifications();
              } catch {
                showAlert("Erreur lors du refus", "error");
              } finally {
                setProcessingId(null);
              }
            }
          : undefined,
      } as NotificationItemProps;
    });
  }, [
    notificationsData,
    processingId,
    respondToInvitation,
    markAsRead,
    showAlert,
    refetchNotifications,
    data,
    handleNavigate,
  ]);

  const totalUnRead = notifications.filter(
    (item) => item.isUnRead === true,
  ).length;
  const hasUnread = totalUnRead > 0;

  const [openPopover, setOpenPopover] = useState<HTMLButtonElement | null>(
    null,
  );

  const handleOpenPopover = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      setOpenPopover(event.currentTarget);
    },
    [],
  );

  const handleClosePopover = useCallback(() => {
    setOpenPopover(null);
  }, []);

  const handleViewAll = useCallback(() => {
    handleClosePopover();
    navigate(`${dashboardBase}/notification`);
  }, [navigate, handleClosePopover, dashboardBase]);

  const handleMarkAllAsRead = useCallback(() => {
    suppressNextBeepRef.current = true;
    markAllAsRead()
      .unwrap()
      .then(() => refetchNotifications())
      .catch(() => showAlert("Erreur lors du marquage", "error"));
  }, [markAllAsRead, refetchNotifications, showAlert]);

  const subtitleText = useMemo(() => {
    if (isLoading) return "Chargement…";
    if (totalUnRead === 0) return "Aucun message non lu";
    return `${totalUnRead} message${totalUnRead > 1 ? "s" : ""} non lu${totalUnRead > 1 ? "s" : ""}`;
  }, [isLoading, totalUnRead]);

  return (
    <>
      {/* Trigger button */}
      <Button
        variant="outlined"
        onClick={handleOpenPopover}
        sx={{
          position: "relative",
          minWidth: { xs: 38, sm: 44 },
          width: { xs: 38, sm: 44 },
          height: { xs: 38, sm: 44 },
          p: 0,
          borderRadius: 1.5,
          borderColor: theme.palette.divider,
          backgroundColor: theme.palette.background.paper,
          color: theme.palette.common.black,
          flexShrink: 0,
          transition: theme.transitions.create([
            "border-color",
            "background-color",
            "color",
          ]),
          "&:hover": {
            borderColor: theme.palette.primary.main,
            backgroundColor: alpha(theme.palette.primary.main, 0.08),
            color: theme.palette.primary.main,
          },
          ...(openPopover && {
            borderColor: theme.palette.primary.main,
            backgroundColor: alpha(theme.palette.primary.main, 0.08),
            color: theme.palette.primary.main,
          }),
          ...sx,
        }}
        {...other}
      >
        <Bell size={20} />

        {hasUnread && (
          <Box
            sx={{
              position: "absolute",
              top: 7,
              right: 7,
              width: 9,
              height: 9,
              borderRadius: "50%",
              backgroundColor: theme.palette.error.main,
              border: `2px solid ${theme.palette.background.paper}`,
            }}
          />
        )}
      </Button>

      <Popover
        open={!!openPopover}
        anchorEl={openPopover}
        onClose={handleClosePopover}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              width: 380,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              mt: 1,
              borderRadius: "16px",
              boxShadow: theme.shadows[8],
            },
          },
        }}
      >
        {/* Header */}
        <Box
          sx={{
            py: 2,
            pl: 2.5,
            pr: 2,
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography
              sx={{ fontWeight: 700, fontSize: 15, color: "text.primary" }}
            >
              Notifications
            </Typography>
            <Typography
              sx={{
                fontSize: 12.5,
                color: hasUnread
                  ? theme.palette.warning.dark
                  : "text.secondary",
                fontWeight: hasUnread ? 600 : 400,
                mt: 0.25,
              }}
            >
              {subtitleText}
            </Typography>
          </Box>

          {hasUnread && (
            <Tooltip title="Tout marquer comme lu">
              <IconButton
                onClick={handleMarkAllAsRead}
                disabled={isMarkingAllAsRead}
                sx={{
                  color: theme.palette.primary.main,
                  "&:hover": {
                    bgcolor: alpha(theme.palette.primary.main, 0.08),
                  },
                }}
              >
                {isMarkingAllAsRead ? (
                  <CircularProgress size={20} />
                ) : (
                  <CheckCheck size={20} />
                )}
              </IconButton>
            </Tooltip>
          )}
        </Box>

        <Divider sx={{ borderStyle: "dashed" }} />

        {/* Notification list */}
        <Scrollbar
          fillContent
          sx={{ minHeight: 240, maxHeight: { xs: 360, sm: 420 } }}
        >
          {isLoading ? (
            <Box
              sx={{
                py: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <CircularProgress size={28} />
            </Box>
          ) : notifications.length === 0 ? (
            <Box
              sx={{
                py: 8,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 1,
              }}
            >
              <Bell size={48} width={56} color={theme.palette.grey[300]} />
              <Typography
                variant="body2"
                sx={{ color: "text.secondary", fontSize: 13 }}
              >
                Aucune notification
              </Typography>
            </Box>
          ) : (
            <>
              <List
                disablePadding
                subheader={
                  <ListSubheader
                    disableSticky
                    sx={{
                      py: 1,
                      px: 2,
                      typography: "overline",
                      fontWeight: 600,
                      color: "text.secondary",
                      backgroundColor: "transparent",
                    }}
                  >
                    Nouveau
                  </ListSubheader>
                }
              >
                {notifications.slice(0, 2).map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                  />
                ))}
              </List>

              <List
                disablePadding
                subheader={
                  <ListSubheader
                    disableSticky
                    sx={{
                      py: 1,
                      px: 2,
                      typography: "overline",
                      fontWeight: 600,
                      color: "text.secondary",
                      backgroundColor: "transparent",
                    }}
                  >
                    Avant
                  </ListSubheader>
                }
              >
                {notifications.slice(2, 20).map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                  />
                ))}
              </List>
            </>
          )}
        </Scrollbar>

        <Divider sx={{ borderStyle: "dashed" }} />

        {/* Footer */}
        <Box sx={{ p: 1 }}>
          <CustomButton
            fullWidth
            variant="text"
            color="primary"
            onClick={handleViewAll}
            sx={{
              fontSize: 13,
              fontWeight: 500,
              borderRadius: "10px",
            }}
          >
            Voir toutes les notifications
          </CustomButton>
        </Box>
      </Popover>
    </>
  );
}
