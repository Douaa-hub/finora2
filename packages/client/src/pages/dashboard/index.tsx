import {
  Grid,
  Card,
  CardContent,
  Typography,
  Box,
  alpha,
  useTheme,
  Skeleton,
} from "@mui/material";
import {
  Clock,
  Users,
  Calendar,
  CheckSquare,
  type LucideIcon,
} from "lucide-react";

import { CONFIG } from "src/config-global";
import { PageHeader } from "src/layouts/components/page-header";
import { useGetAllRequestsQuery } from "src/lib/services/requestApi";
import { useGetClientsQuery } from "src/lib/services/clientApi";
import { useGetAllAppointmentsQuery } from "src/lib/services/appointmentsApi";
import { useGetMyCreatedTasksQuery } from "src/lib/services/tasksApi";

// ----------------------------------------------------------------------

interface StatCardProps {
  label: string;
  icon: LucideIcon;
  color: string;
  value: number | null | undefined;
  isLoading: boolean;
}

function StatCard({
  label,
  icon: Icon,
  color,
  value,
  isLoading,
}: StatCardProps) {
  const theme = useTheme();

  return (
    <Card
      sx={{
        borderRadius: 4,
        boxShadow: `0 4px 20px ${alpha(theme.palette.common.black, 0.06)}`,
        border: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
        height: "100%",
      }}
    >
      <CardContent sx={{ p: 3 }}>
        <Box
          sx={{
            width: 48,
            height: 48,
            borderRadius: 3,
            bgcolor: alpha(color, 0.12),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            mb: 2.5,
          }}
        >
          <Icon size={22} color={color} />
        </Box>

        {isLoading ? (
          <Skeleton variant="text" width={60} height={48} sx={{ mb: 0.5 }} />
        ) : (
          <Typography variant="h4" fontWeight={700} sx={{ mb: 0.5 }}>
            {value ?? "—"}
          </Typography>
        )}

        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------------

export default function DashboardPage() {
  const { data: requestsData, isLoading: loadingRequests } =
    useGetAllRequestsQuery({
      status: "pending",
      limit: 1,
      page: 1,
    });

  const { data: clientsData, isLoading: loadingClients } = useGetClientsQuery({
    page: 1,
    limit: 1,
  });

  const { data: appointmentsData, isLoading: loadingAppointments } =
    useGetAllAppointmentsQuery({
      period: "upcoming",
      limit: 1,
      page: 1,
    });

  const { data: tasksData, isLoading: loadingTasks } =
    useGetMyCreatedTasksQuery({
      status: "in_progress",
      limit: 1,
      page: 1,
    });

  const stats = [
    {
      label: "Demandes en attente",
      icon: Clock,
      color: "#F59E0B",
      value: requestsData?.pagination?.total,
      isLoading: loadingRequests,
    },
    {
      label: "Clients actifs",
      icon: Users,
      color: "#3B82F6",
      value: clientsData?.pagination?.total,
      isLoading: loadingClients,
    },
    {
      label: "Rendez-vous à venir",
      icon: Calendar,
      color: "#8B5CF6",
      value: appointmentsData?.pagination?.total,
      isLoading: loadingAppointments,
    },
    {
      label: "Tâches en cours",
      icon: CheckSquare,
      color: "#10B981",
      value: tasksData?.pagination?.total,
      isLoading: loadingTasks,
    },
  ] as const;

  return (
    <>
      <title>{`Tableau de bord - ${CONFIG.appName}`}</title>

      <PageHeader
        title="Tableau de bord"
        caption="Vue d'ensemble de votre activité"
      >
        <Grid container spacing={3}>
          {stats.map((stat) => (
            <Grid key={stat.label} size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard {...stat} />
            </Grid>
          ))}
        </Grid>
      </PageHeader>
    </>
  );
}
