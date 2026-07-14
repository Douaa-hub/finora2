import type { Breakpoint } from "@mui/material/styles";

import { merge } from "es-toolkit";
import { useBoolean } from "minimal-shared/hooks";

import Box from "@mui/material/Box";
import Alert from "@mui/material/Alert";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";

import { NavMobile, NavDesktop } from "./nav";
import { layoutClasses } from "../core/classes";
import { _account } from "../nav-config-account";
import { dashboardLayoutVars } from "./css-vars";
import { useNavigation } from "src/hooks/useNavigation";
import { MainSection } from "../core/main-section";
import { MenuButton } from "../components/menu-button";
import { HeaderSection } from "../core/header-section";
import { LayoutSection } from "../core/layout-section";
import { AccountPopover } from "../components/account-popover";

import type { MainSectionProps } from "../core/main-section";
import type { HeaderSectionProps } from "../core/header-section";
import type { LayoutSectionProps } from "../core/layout-section";
import { NotificationsPopover } from "../components/notifications-popover";
import { MessagesPopover } from "../components/messages-popover";
import Logo from "src/components/common/Logo";
import { GlobalFileDrawer } from "src/components/common/FileDrawer";
import { GlobalCallHandler } from "../components/GlobalCallHandler";
import { GlobalCallProvider } from "src/contexts/GlobalCallContext";
import {
  HeaderSearchProvider,
  useHeaderSearch,
} from "src/contexts/HeaderSearchContext";
import ChatbotWidget from "src/components/chatbot/ChatbotWidget";
import { useVerifyUserQuery } from "src/lib/services/authApi";

// ----------------------------------------------------------------------

type LayoutBaseProps = Pick<LayoutSectionProps, "sx" | "children" | "cssVars">;

export type DashboardLayoutProps = LayoutBaseProps & {
  layoutQuery?: Breakpoint;
  slotProps?: {
    header?: HeaderSectionProps;
    main?: MainSectionProps;
  };
};

// Inner component — consumes the HeaderSearchContext
function DashboardLayoutInner({
  sx,
  cssVars,
  children,
  slotProps,
  layoutQuery = "lg",
}: DashboardLayoutProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down(layoutQuery));

  const { value: open, onFalse: onClose, onTrue: onOpen } = useBoolean();
  const navItems = useNavigation();
  const { searchContent } = useHeaderSearch();

  const { data: userData } = useVerifyUserQuery();
  const roleCode =
    userData?.role && typeof userData.role === "object"
      ? userData.role.code
      : typeof userData?.role === "string"
        ? userData.role
        : "";
  const isClient =
    roleCode === "CLIENT" ||
    (typeof roleCode === "string" && roleCode.toLowerCase() === "client");

  const renderHeader = () => {
    const headerSlotProps: HeaderSectionProps["slotProps"] = {
      container: {
        maxWidth: false,
        sx: {
          px: { xs: 1.25, sm: 1.5, md: 2 },
          minWidth: 0,
        },
      },
      centerArea: {
        sx: {
          ...(isMobile
            ? {
                display: "none",
                flex: "0 0 auto",
                width: 0,
                minWidth: 0,
              }
            : {
                display: "flex",
                flex: "1 1 auto",
                justifyContent: "center",
                minWidth: 0,
                px: 2,
              }),
        },
      },
    };

    const headerSlots: HeaderSectionProps["slots"] = {
      topArea: (
        <Alert severity="info" sx={{ display: "none", borderRadius: 0 }}>
          This is an info Alert.
        </Alert>
      ),
      leftArea: (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            minWidth: 0,
            // flex-shrink:0 on desktop prevents logo from being compressed
            // when centerArea has content — safe on other pages (empty center
            // takes no visible space regardless)
            flex: isMobile ? "1 1 auto" : "0 0 auto",
          }}
        >
          <MenuButton
            onClick={onOpen}
            sx={{
              mr: 1,
              ml: -0.5,
              flexShrink: 0,
              [theme.breakpoints.up(layoutQuery)]: { display: "none" },
            }}
          />

          <NavMobile data={navItems} open={open} onClose={onClose} />

          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <Logo variant="primary" size={isMobile ? 132 : 160} />
          </Box>
        </Box>
      ),
      rightArea: (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            flexShrink: 0,
            ml: isMobile ? 0.5 : 0,
            gap: { xs: 0.3, sm: 0.75 },
          }}
        >
          <MessagesPopover />

          {/** @slot Notifications popover */}
          <NotificationsPopover />

          {/** @slot Account drawer */}
          <AccountPopover data={_account} />
        </Box>
      ),
    };

    return (
      <HeaderSection
        disableElevation
        disableOffset
        layoutQuery={layoutQuery}
        {...slotProps?.header}
        slots={{ ...headerSlots, ...slotProps?.header?.slots }}
        slotProps={merge(headerSlotProps, slotProps?.header?.slotProps ?? {})}
        sx={[
          (themeProps) => ({
            bgcolor: themeProps.palette.common.white,
            borderRadius: 3,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            flexDirection: "row",
            m: 1.5,
            width: "calc(100% - 24px)",
            height: "var(--layout-header-mobile-height)",
            [themeProps.breakpoints.down(layoutQuery)]: {
              minHeight: 64,
            },
            [themeProps.breakpoints.up(layoutQuery)]: {
              position: "fixed",
              top: 12,
              left: 12,
              right: 12,
              m: 0,
              width: "auto",
              zIndex: "calc(var(--layout-nav-zIndex) + 1)",
            },
          }),
          ...(Array.isArray(slotProps?.header?.sx)
            ? (slotProps?.header?.sx ?? [])
            : [slotProps?.header?.sx]),
        ]}
      />
    );
  };

  const renderFooter = () => null;

  const renderMain = () => (
    <MainSection {...slotProps?.main}>
      {children}
      <GlobalFileDrawer />
      <GlobalCallHandler />
      {isClient && <ChatbotWidget />}
    </MainSection>
  );

  return (
    <GlobalCallProvider>
      <LayoutSection
        headerSection={renderHeader()}
        sidebarSection={
          <NavDesktop data={navItems} layoutQuery={layoutQuery} />
        }
        footerSection={renderFooter()}
        cssVars={{ ...dashboardLayoutVars(theme), ...cssVars }}
        sx={[
          {
            [`& .${layoutClasses.sidebarContainer}`]: {
              [theme.breakpoints.up(layoutQuery)]: {
                pl: "var(--layout-nav-vertical-width)",
                pt: "calc(var(--layout-header-desktop-height) + 24px)",
                transition: theme.transitions.create(["padding-left"], {
                  easing: "var(--layout-transition-easing)",
                  duration: "var(--layout-transition-duration)",
                }),
              },
            },
          },
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}
      >
        {renderMain()}
      </LayoutSection>
    </GlobalCallProvider>
  );
}

// Public export — wraps with HeaderSearchProvider so any child page can inject
// content into the header via useHeaderSearch()
export function DashboardLayout(props: DashboardLayoutProps) {
  return (
    <HeaderSearchProvider>
      <DashboardLayoutInner {...props} />
    </HeaderSearchProvider>
  );
}
