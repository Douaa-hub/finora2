import React from "react";
import { Box, useTheme } from "@mui/material";
import Avatar from "@mui/material/Avatar";
import Typography from "@mui/material/Typography";
import ListItemAvatar from "@mui/material/ListItemAvatar";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import { fToNow } from "src/utils/format-time";
import CustomButton from "src/components/common/CustomButton";

export type NotificationItemProps = {
  id: string;
  type: string;
  title: string;
  isUnRead: boolean;
  description: string;
  avatarUrl: string | null;
  postedAt: string | number | null;
  actionUrl?: string;
  canRespond?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
  onNavigate?: (url: string) => void;
  onMarkAsRead?: (id: string) => void;
  isProcessing?: boolean;
};

function renderContent(notification: NotificationItemProps) {
  const title = (
    <Typography variant="caption" fontWeight={600}>
      {notification.title}
      <Typography component="span" variant="caption" color="">
        &nbsp; {notification.description}
      </Typography>
    </Typography>
  );

  if (notification.type === "order-placed") {
    return {
      avatarUrl: (
        <img
          alt={notification.title}
          src="/assets/icons/notification/ic-notification-package.svg"
        />
      ),
      title,
    };
  }
  if (notification.type === "order-shipped") {
    return {
      avatarUrl: (
        <img
          alt={notification.title}
          src="/assets/icons/notification/ic-notification-shipping.svg"
        />
      ),
      title,
    };
  }
  if (notification.type === "mail") {
    return {
      avatarUrl: (
        <img
          alt={notification.title}
          src="/assets/icons/notification/ic-notification-mail.svg"
        />
      ),
      title,
    };
  }
  if (notification.type === "chat-message") {
    return {
      avatarUrl: (
        <img
          alt={notification.title}
          src="/assets/icons/notification/ic-notification-chat.svg"
        />
      ),
      title,
    };
  }
  return {
    avatarUrl: notification.avatarUrl ? (
      <img alt={notification.title} src={notification.avatarUrl} />
    ) : null,
    title,
  };
}

export function NotificationItem({
  notification,
}: {
  notification: NotificationItemProps;
}) {
  const { avatarUrl, title } = renderContent(notification);
  const theme = useTheme();

  const handleClick = () => {
    if (notification.actionUrl && notification.onNavigate) {
      notification.onNavigate(notification.actionUrl);
    }
    if (notification.isUnRead && notification.onMarkAsRead) {
      const markId = notification.id;
      const markFn = notification.onMarkAsRead;
      setTimeout(() => {
        markFn(markId);
      }, 0);
    }
  };

  return (
    <ListItemButton
      onClick={handleClick}
      sx={{
        cursor: notification.actionUrl ? "pointer" : "default",
        ...(notification.isUnRead && {
          bgcolor: "primary.lighter",
        }),
      }}
    >
      <ListItemAvatar>
        <Avatar
          sx={{
            background: `linear-gradient(135deg, ${theme.palette.primary.main}, ${theme.palette.primary.dark})`,
          }}
        >
          {avatarUrl}
        </Avatar>
      </ListItemAvatar>
      <ListItemText
        primary={title}
        primaryTypographyProps={{
          fontWeight: notification.isUnRead ? 600 : 400,
          color: notification.isUnRead ? "text.primary" : "text.disabled",
        }}
        secondary={
          <Typography
            variant="caption"
            fontWeight={notification.isUnRead ? 600 : 400}
            color={notification.isUnRead ? "primary" : "text.disabled"}
            sx={{
              mt: 0.5,
              gap: 0.5,
              display: "flex",
              alignItems: "center",
            }}
          >
            {fToNow(notification.postedAt)}
          </Typography>
        }
      />
      {notification.canRespond && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, ml: 1 }}>
          <CustomButton
            size="small"
            variant="contained"
            color="success"
            onClick={(e) => {
              e.stopPropagation();
              notification.onAccept?.();
            }}
            loading={notification.isProcessing}
          >
            Accepter
          </CustomButton>
          <CustomButton
            size="small"
            variant="outlined"
            color="error"
            onClick={(e) => {
              e.stopPropagation();
              notification.onReject?.();
            }}
            disabled={notification.isProcessing}
          >
            Refuser
          </CustomButton>
        </Box>
      )}
    </ListItemButton>
  );
}
