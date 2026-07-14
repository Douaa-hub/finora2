import type { RouteObject } from "react-router";
import { Outlet } from "react-router-dom";
import { lazy, Suspense } from "react";
import Box from "@mui/material/Box";

import DotSpinner from "src/components/common/DotSpinner";

import { DashboardLayout } from "src/layouts/dashboard";

import AuthGuard from "src/guard/AuthGuard";
import PermissionGuard from "src/guard/PermissionGuard";
import DefaultRedirect from "src/components/default-redirect";
import DashboardRoleRedirect from "src/components/dashboard-role-redirect";
import RoleView from "src/sections/roles";
import RoleFormRouter from "src/sections/roles/RoleFormRouter";
import AuthLayout from "src/sections/auth/sign-in-view/Auth-Layout";
import LandingPage from "src/pages/landing";

// ----------------------------------------------------------------------

export const UserPage = lazy(() => import("src/pages/users"));
export const CollaboratorPage = lazy(() => import("src/pages/collaborators"));
export const TaskManagementPage = lazy(
  () => import("src/pages/collaborators/task-management"),
);
export const TaskDetailsPage = lazy(
  () => import("src/pages/collaborators/task-details"),
);
export const ClientPage = lazy(() => import("src/pages/clients"));
export const MessagesPage = lazy(() => import("src/pages/messages"));
export const RequestPage = lazy(() => import("src/pages/requests"));
export const FacturesPage = lazy(() => import("src/pages/factures"));
export const DevisPage = lazy(() => import("src/pages/devis"));
export const SuppliersPage = lazy(() => import("src/pages/suppliers"));
export const BonCommandePage = lazy(() => import("src/pages/bon-commande"));
export const BonLivraisonPage = lazy(() => import("src/pages/bon-livraison"));
export const ProductsPage = lazy(() => import("src/pages/products"));
export const ProfilePage = lazy(() => import("src/pages/profile"));
export const CompanySettingsPage = lazy(
  () => import("src/pages/settings/company"),
);
export const NetworkPage = lazy(() => import("src/pages/network"));
export const NetworkAccountantProfilePage = lazy(() =>
  import("src/pages/network/accountant-profile").then((m) => ({
    default: m.default,
  })),
);
export const DocumentsPage = lazy(
  () => import("src/pages/documents/documents"),
);

export const DocumentDetailsPage = lazy(
  () => import("src/pages/documents/documents-details"),
);
export const MeetingsPage = lazy(() => import("src/pages/meetings"));
export const DashboardPage = lazy(() => import("src/pages/dashboard"));

export const NotificationsPage = lazy(
  () => import("src/pages/notifications/index"),
);

export const ArchivePage = lazy(() => import("src/pages/archive/index"));
export const ArchiveDetailsPage = lazy(
  () => import("src/pages/archive/archive-details"),
);

export const UserFormPage = lazy(
  () => import("src/sections/user/user-forms/index"),
);
export const DocumentValidationPage = lazy(
  () => import("src/sections/user/document-validation/index"),
);
export const SignInPage = lazy(() => import("src/pages/sign-in"));
export const RegisterPage = lazy(() => import("src/pages/register"));
export const VisitorPage = lazy(() => import("src/pages/visitor"));
export const EntryPointPage = lazy(() =>
  import("src/components/entry-point").then((m) => ({ default: m.default })),
);
export const AccountantPublicProfilePage = lazy(() =>
  import("src/sections/profile/accountant-public-view").then((m) => ({
    default: m.default,
  })),
);

export const ForgotPasswordPage = lazy(
  () => import("src/pages/forgot-password"),
);
export const ResetPasswordPage = lazy(() => import("src/pages/reset-password"));
export const Page404 = lazy(() => import("src/pages/page-not-found"));
export const PageForbidden = lazy(() => import("src/pages/page-forbidden"));
export const CheckEmailPage = lazy(() => import("src/pages/check-email"));

// ----------------------------------------------------------------------

const renderFallback = () => (
  <Box
    sx={{
      display: "flex",
      flex: "1 1 auto",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    <DotSpinner size={40} />
  </Box>
);

function DashboardWrapper() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <Suspense fallback={renderFallback()}>
          <Outlet />
        </Suspense>
      </DashboardLayout>
    </AuthGuard>
  );
}

// ----------------------------------------------------------------------

export const routesSection: RouteObject[] = [
  {
    path: "/",
    element: (
      <Suspense fallback={renderFallback()}>
        <EntryPointPage />
      </Suspense>
    ),
  },

  {
    path: "dashboard",
    element: <Outlet />,
    children: [
      {
        index: true,
        element: <DashboardRoleRedirect />,
      },
      {
        path: "users",
        element: (
          <PermissionGuard requiredPath="/archive">
            <UserPage />
          </PermissionGuard>
        ),
      },
      {
        path: "collaborators",
        element: (
          <PermissionGuard requiredPath="/collaborators">
            <CollaboratorPage />
          </PermissionGuard>
        ),
      },

      {
        path: "clients",
        element: (
          <PermissionGuard requiredPath="/clients">
            <ClientPage />
          </PermissionGuard>
        ),
      },
      {
        path: "dashboard",
        element: (
          <PermissionGuard requiredPath="/dashboard">
            <DashboardPage />
          </PermissionGuard>
        ),
      },
      {
        path: "documents",
        element: (
          <PermissionGuard requiredPath="/documents">
            <UserPage />
          </PermissionGuard>
        ),
      },
      {
        path: "documents/:id",
        element: (
          <PermissionGuard requiredPath="/documents/:id">
            <UserPage />
          </PermissionGuard>
        ),
      },
      {
        path: "meetings",
        element: (
          <PermissionGuard requiredPath="/meetings">
            <UserPage />
          </PermissionGuard>
        ),
      },
      {
        path: "meetings/:id",
        element: (
          <PermissionGuard requiredPath="/meetings/:id">
            <UserPage />
          </PermissionGuard>
        ),
      },
      {
        path: "requests",
        element: (
          <PermissionGuard requiredPath="/requests">
            <UserPage />
          </PermissionGuard>
        ),
      },
      {
        path: "requests/:id",
        element: (
          <PermissionGuard requiredPath="/requests/:id">
            <UserPage />
          </PermissionGuard>
        ),
      },
      {
        path: "messages",
        element: (
          <PermissionGuard requiredPath="/messages">
            <MessagesPage />
          </PermissionGuard>
        ),
      },
      {
        path: "messages/:id",
        element: (
          <PermissionGuard requiredPath="/messages/:id">
            <MessagesPage />
          </PermissionGuard>
        ),
      },
      {
        path: "network",
        element: (
          <PermissionGuard requiredPath="/network">
            <UserPage />
          </PermissionGuard>
        ),
      },
      {
        path: "profile",
        element: (
          <PermissionGuard requiredPath="/profile">
            <UserPage />
          </PermissionGuard>
        ),
      },
      {
        path: "profile/edit",
        element: (
          <PermissionGuard requiredPath="/profile/edit">
            <UserPage />
          </PermissionGuard>
        ),
      },
      {
        path: "settings/company",
        element: (
          <PermissionGuard
            requiredPath="/settings/company"
            allowForRole="CLIENT"
          >
            <CompanySettingsPage />
          </PermissionGuard>
        ),
      },
      {
        path: "user/new",
        element: (
          <PermissionGuard requiredPath="/users">
            <UserFormPage />
          </PermissionGuard>
        ),
      },
      {
        path: "user/edit/:id",
        element: (
          <PermissionGuard requiredPath="/users">
            <UserFormPage />
          </PermissionGuard>
        ),
      },
      {
        path: "user/:id/documents",
        element: (
          <PermissionGuard requiredPath="/users">
            <DocumentValidationPage />
          </PermissionGuard>
        ),
      },
      {
        path: "roles",
        element: (
          <PermissionGuard requiredPath="/roles">
            <RoleView />
          </PermissionGuard>
        ),
      },
      {
        path: "role/new",
        element: (
          <PermissionGuard requiredPath="/roles">
            <RoleFormRouter />
          </PermissionGuard>
        ),
      },
      {
        path: "role/edit/:id",
        element: (
          <PermissionGuard requiredPath="/roles">
            <RoleFormRouter />
          </PermissionGuard>
        ),
      },
      {
        path: ":roleSlug",
        Component: DashboardWrapper,
        children: [
          {
            index: true,
            element: <DefaultRedirect />,
          },
          {
            path: "archive",
            element: (
              <PermissionGuard requiredPath="/archive">
                <ArchivePage />
              </PermissionGuard>
            ),
          },
          {
            path: "archive/:clientId",
            element: (
              <PermissionGuard requiredPath="/archive">
                <ArchiveDetailsPage />
              </PermissionGuard>
            ),
          },
          {
            path: "collaborators",
            element: (
              <PermissionGuard requiredPath="/collaborators">
                <CollaboratorPage />
              </PermissionGuard>
            ),
          },
          {
            path: "notification",
            element: (
              <PermissionGuard
                requiredPath="/notification"
                allowForRoleCodes={[
                  "CLIENT",
                  "ACCOUNTANT",
                  "COMPTABLE",
                  "COLLABORATOR",
                  "COLLABORATEUR",
                  "ADMINISTRATOR",
                  "SUPER_ADMIN",
                ]}
              >
                <NotificationsPage />
              </PermissionGuard>
            ),
          },
          {
            path: "collaborators/task-management",
            element: (
              <PermissionGuard requiredPath="/collaborators">
                <TaskManagementPage />
              </PermissionGuard>
            ),
          },
          {
            path: "collaborators/task-management/:taskId",
            element: (
              <PermissionGuard requiredPath="/collaborators">
                <TaskDetailsPage />
              </PermissionGuard>
            ),
          },
          {
            path: "tasks",
            element: (
              <PermissionGuard
                requiredPath="/collaborators"
                allowForRoleCodes={["COLLABORATOR", "COLLABORATEUR"]}
              >
                <TaskManagementPage />
              </PermissionGuard>
            ),
          },
          {
            path: "tasks/:taskId",
            element: (
              <PermissionGuard
                requiredPath="/collaborators"
                allowForRoleCodes={["COLLABORATOR", "COLLABORATEUR"]}
              >
                <TaskDetailsPage />
              </PermissionGuard>
            ),
          },
          {
            path: "clients",
            element: (
              <PermissionGuard requiredPath="/clients">
                <ClientPage />
              </PermissionGuard>
            ),
          },
          {
            path: "users",
            element: (
              <PermissionGuard requiredPath="/users">
                <UserPage />
              </PermissionGuard>
            ),
          },
          {
            path: "users/:id",
            element: (
              <PermissionGuard requiredPath="/users">
                <UserPage />
              </PermissionGuard>
            ),
          },
          {
            path: "dashboard",
            element: (
              <PermissionGuard requiredPath="/dashboard">
                <DashboardPage />
              </PermissionGuard>
            ),
          },
          {
            path: "documents",
            element: (
              <PermissionGuard requiredPath="/documents">
                <DocumentsPage />
              </PermissionGuard>
            ),
          },
          {
            path: "documents/:clientId",
            element: (
              <PermissionGuard requiredPath="/documents">
                <DocumentDetailsPage />
              </PermissionGuard>
            ),
          },
          {
            path: "meetings",
            element: (
              <PermissionGuard requiredPath="/meetings">
                <MeetingsPage />
              </PermissionGuard>
            ),
          },
          {
            path: "meetings/:id",
            element: (
              <PermissionGuard requiredPath="/meetings/:id">
                <MeetingsPage />
              </PermissionGuard>
            ),
          },
          {
            path: "requests",
            element: (
              <PermissionGuard requiredPath="/requests">
                <RequestPage />
              </PermissionGuard>
            ),
          },
          {
            path: "factures",
            element: (
              <PermissionGuard requiredPath="/factures" allowForRole="CLIENT">
                <FacturesPage />
              </PermissionGuard>
            ),
          },
          {
            path: "devis",
            element: (
              <PermissionGuard requiredPath="/devis" allowForRole="CLIENT">
                <DevisPage />
              </PermissionGuard>
            ),
          },
          {
            path: "suppliers",
            element: (
              <PermissionGuard requiredPath="/suppliers" allowForRole="CLIENT">
                <SuppliersPage />
              </PermissionGuard>
            ),
          },
          {
            path: "bons-commande",
            element: (
              <PermissionGuard
                requiredPath="/bons-commande"
                allowForRole="CLIENT"
              >
                <BonCommandePage />
              </PermissionGuard>
            ),
          },
          {
            path: "bons-livraison",
            element: (
              <PermissionGuard
                requiredPath="/bons-livraison"
                allowForRole="CLIENT"
              >
                <BonLivraisonPage />
              </PermissionGuard>
            ),
          },
          {
            path: "products",
            element: (
              <PermissionGuard requiredPath="/products" allowForRole="CLIENT">
                <ProductsPage />
              </PermissionGuard>
            ),
          },
          {
            path: "requests/:id",
            element: (
              <PermissionGuard requiredPath="/requests/:id">
                <RequestPage />
              </PermissionGuard>
            ),
          },
          {
            path: "messages",
            element: (
              <PermissionGuard requiredPath="/messages">
                <MessagesPage />
              </PermissionGuard>
            ),
          },
          {
            path: "messages/:id",
            element: (
              <PermissionGuard requiredPath="/messages/:id">
                <MessagesPage />
              </PermissionGuard>
            ),
          },
          {
            path: "network/accountant/:id",
            element: (
              <PermissionGuard requiredPath="/network">
                <Suspense fallback={renderFallback()}>
                  <NetworkAccountantProfilePage />
                </Suspense>
              </PermissionGuard>
            ),
          },
          {
            path: "network",
            element: (
              <PermissionGuard requiredPath="/network">
                <NetworkPage />
              </PermissionGuard>
            ),
          },
          {
            path: "profile",
            element: (
              <PermissionGuard requiredPath="/profile">
                <ProfilePage />
              </PermissionGuard>
            ),
          },
          {
            path: "profile/edit",
            element: (
              <PermissionGuard requiredPath="/profile/edit">
                <UserPage />
              </PermissionGuard>
            ),
          },
          {
            path: "settings/company",
            element: (
              <PermissionGuard
                requiredPath="/settings/company"
                allowForRole="CLIENT"
              >
                <CompanySettingsPage />
              </PermissionGuard>
            ),
          },
          {
            path: "user/new",
            element: (
              <PermissionGuard requiredPath="/users">
                <UserFormPage />
              </PermissionGuard>
            ),
          },
          {
            path: "user/edit/:id",
            element: (
              <PermissionGuard requiredPath="/users">
                <UserFormPage />
              </PermissionGuard>
            ),
          },
          {
            path: "user/:id/documents",
            element: (
              <PermissionGuard requiredPath="/users">
                <DocumentValidationPage />
              </PermissionGuard>
            ),
          },
          {
            path: "roles",
            element: (
              <PermissionGuard requiredPath="/roles">
                <RoleView />
              </PermissionGuard>
            ),
          },
          {
            path: "role/new",
            element: (
              <PermissionGuard requiredPath="/roles">
                <RoleFormRouter />
              </PermissionGuard>
            ),
          },
          {
            path: "role/edit/:id",
            element: (
              <PermissionGuard requiredPath="/roles">
                <RoleFormRouter />
              </PermissionGuard>
            ),
          },
        ],
      },
    ],
  },

  {
    path: "visitor",
    element: <VisitorPage />,
  },

  {
    path: "landing",
    element: <LandingPage />,
  },

  {
    path: "accountant/:id",
    element: (
      <Suspense fallback={renderFallback()}>
        <AccountantPublicProfilePage />
      </Suspense>
    ),
  },
  {
    path: "sign-in",
    element: <AuthLayout />,
    children: [
      {
        index: true,
        element: <SignInPage />,
      },
    ],
  },
  {
    path: "register",
    element: <AuthLayout />,
    children: [
      {
        index: true,
        element: <RegisterPage />,
      },
    ],
  },
  {
    path: "check-email",
    element: <AuthLayout />,
    children: [
      {
        index: true,
        element: <CheckEmailPage />,
      },
    ],
  },
  {
    path: "forgot-password",
    element: <AuthLayout />,
    children: [
      {
        index: true,
        element: <ForgotPasswordPage />,
      },
    ],
  },
  {
    path: "reset-password",
    element: <AuthLayout />,
    children: [
      {
        index: true,
        element: <ResetPasswordPage />,
      },
    ],
  },

  { path: "403", element: <PageForbidden /> },
  { path: "404", element: <Page404 /> },
  { path: "*", element: <Page404 /> },
];
