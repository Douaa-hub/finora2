import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  IconButton,
  Switch,
  Typography,
  useTheme,
} from "@mui/material";
import { Check, Plus, Search, Trash2, X } from "lucide-react";
import { PageHeader } from "src/layouts/components/page-header";
import CustomButton from "src/components/common/CustomButton";
import CustomInput from "src/components/common/CustomInput";
import { FolderTabNavigation } from "src/components/common/CustomTabs";
import AppointmentCard from "src/components/appointment/AppointmentCard";
import AppointmentDetailsDialog from "src/components/appointment/AppointmentDetailsDialog";
import MonthlyAppointmentCalendar from "src/components/appointment/MonthlyAppointmentCalendar";
import NewAppointmentWizard from "src/components/appointment/NewAppointmentWizard";
import { CustomPagination } from "src/layouts/components/table-pagination";
import {
  type AppointmentItem,
  type AvailabilityItem,
  useCreateAppointmentMutation,
  useCreateAvailabilityMutation,
  useCreateLeaveMutation,
  useDeleteAvailabilityMutation,
  useDeleteLeaveMutation,
  useGetAllAppointmentsQuery,
  useGetAppointmentByIdQuery,
  useGetConfirmedThisMonthQuery,
  useGetMyAvailabilitiesQuery,
  useGetMyAppointmentsQuery,
  useGetMyLeavesQuery,
  useCancelAppointmentMutation,
  useUpdateAppointmentMutation,
  useReportAppointmentMutation,
  useRespondAppointmentMutation,
  useUpdateAvailabilityMutation,
} from "src/lib/services/appointmentsApi";
import { useVerifyUserQuery } from "src/lib/services/authApi";
import {
  useGetClientsQuery,
  useGetMyAccountantsQuery,
} from "src/lib/services/clientApi";

type Mode = "appointments" | "availability";
type TimeTab = "today" | "upcoming" | "past";

const WEEK_DAYS = [
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
  "Dimanche",
] as const;

const DAY_FR_TO_API: Record<(typeof WEEK_DAYS)[number], string> = {
  Lundi: "lundi",
  Mardi: "mardi",
  Mercredi: "mercredi",
  Jeudi: "jeudi",
  Vendredi: "vendredi",
  Samedi: "samedi",
  Dimanche: "dimanche",
};

const DAY_API_TO_FR: Record<string, (typeof WEEK_DAYS)[number]> = {
  lundi: "Lundi",
  mardi: "Mardi",
  mercredi: "Mercredi",
  jeudi: "Jeudi",
  vendredi: "Vendredi",
  samedi: "Samedi",
  dimanche: "Dimanche",
};

type UiSlot = {
  id?: number;
  localId: string;
  start: string;
  end: string;
};

type InitialSlotSnapshot = {
  start: string;
  end: string;
  slotDuration: number;
  isActive: boolean;
};

function formatMonthLabelFr(date: Date) {
  return date.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

function toDateInputValue(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function deriveSubjectFromAppointment(appointment: any): string {
  const rawType = appointment?.type ?? "";
  if (rawType === "review") return "facturation";

  const text =
    `${appointment?.title ?? ""} ${appointment?.description ?? ""}`.toLowerCase();
  if (text.includes("budget")) return "budget";

  return "bilan";
}

function getUserRoleCode(me: any): string {
  const rawRole = me?.role;
  if (typeof rawRole === "string") return rawRole.toUpperCase();
  if (rawRole && typeof rawRole === "object") {
    const code = String((rawRole as any).code ?? "").toUpperCase();
    if (code) return code;
    const name = String((rawRole as any).name ?? "").toUpperCase();
    if (name) return name;
  }
  return "";
}

// ─── Availability Settings ────────────────────────────────────────────────────

function AvailabilitySettings() {
  const [vacationEnabled, setVacationEnabled] = useState(false);
  const [vacationStart, setVacationStart] = useState("");
  const [vacationEnd, setVacationEnd] = useState("");
  const [vacationReason, setVacationReason] = useState("");
  const [duration, setDuration] = useState("30");
  const [enabledDays, setEnabledDays] = useState<Record<string, boolean>>({
    Lundi: true,
    Mardi: true,
    Mercredi: false,
    Jeudi: false,
    Vendredi: false,
    Samedi: false,
    Dimanche: false,
  });
  const [slots, setSlots] = useState<Record<string, UiSlot[]>>({
    Lundi: [{ localId: "Lundi-default", start: "09:00", end: "12:00" }],
    Mardi: [{ localId: "Mardi-default", start: "09:00", end: "12:00" }],
  });
  const [removedSlotIds, setRemovedSlotIds] = useState<number[]>([]);
  const [initialSignature, setInitialSignature] = useState("");
  const [initialSlotsById, setInitialSlotsById] = useState<
    Record<number, InitialSlotSnapshot>
  >({});
  const [saveError, setSaveError] = useState("");

  const {
    data: availabilitiesData,
    isLoading: isLoadingAvailabilities,
    refetch: refetchAvailabilities,
  } = useGetMyAvailabilitiesQuery({ onlyActive: false });
  const [createAvailability, { isLoading: isCreatingAvailability }] =
    useCreateAvailabilityMutation();
  const [updateAvailability, { isLoading: isUpdatingAvailability }] =
    useUpdateAvailabilityMutation();
  const [deleteAvailability, { isLoading: isDeletingAvailability }] =
    useDeleteAvailabilityMutation();
  const { data: leavesData, refetch: refetchLeaves } = useGetMyLeavesQuery();
  const [createLeave, { isLoading: isCreatingLeave }] =
    useCreateLeaveMutation();
  const [deleteLeave, { isLoading: isDeletingLeave }] =
    useDeleteLeaveMutation();

  const isSavingAvailability =
    isCreatingAvailability || isUpdatingAvailability || isDeletingAvailability;
  const leaves = leavesData?.data ?? [];

  const signatureFor = (
    argDuration: string,
    argEnabledDays: Record<string, boolean>,
    argSlots: Record<string, UiSlot[]>,
    argRemovedIds: number[],
  ) => {
    const normalized = {
      duration: argDuration,
      enabledDays: WEEK_DAYS.map((d) => ({
        day: d,
        enabled: !!argEnabledDays[d],
      })),
      slots: WEEK_DAYS.map((d) => ({
        day: d,
        slots: (argSlots[d] || [])
          .map((s) => ({ id: s.id ?? null, start: s.start, end: s.end }))
          .sort(
            (a, b) =>
              a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
          ),
      })),
      removed: [...argRemovedIds].sort((a, b) => a - b),
    };
    return JSON.stringify(normalized);
  };

  const hydrateFromApi = (availabilityItems: AvailabilityItem[]) => {
    const nextEnabledDays: Record<string, boolean> = Object.fromEntries(
      WEEK_DAYS.map((d) => [d, false]),
    );
    const nextSlots: Record<string, UiSlot[]> = Object.fromEntries(
      WEEK_DAYS.map((d) => [d, []]),
    );
    let firstDuration = "30";
    const nextInitialById: Record<number, InitialSlotSnapshot> = {};

    availabilityItems
      .filter((a) => a.isRecurring && a.dayOfWeek)
      .forEach((a) => {
        const frDay = DAY_API_TO_FR[String(a.dayOfWeek).toLowerCase()];
        if (!frDay) return;
        if (a.isActive) nextEnabledDays[frDay] = true;
        nextSlots[frDay].push({
          id: a.id,
          localId: `api-${a.id}`,
          start: a.startTime,
          end: a.endTime,
        });
        nextInitialById[a.id] = {
          start: a.startTime,
          end: a.endTime,
          slotDuration: a.slotDuration,
          isActive: a.isActive,
        };
        if (a.slotDuration) firstDuration = String(a.slotDuration);
      });

    WEEK_DAYS.forEach((d) => {
      nextSlots[d].sort(
        (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
      );
    });

    setDuration(firstDuration);
    setEnabledDays(nextEnabledDays);
    setSlots(nextSlots);
    setInitialSlotsById(nextInitialById);
    setRemovedSlotIds([]);
    setInitialSignature(
      signatureFor(firstDuration, nextEnabledDays, nextSlots, []),
    );
  };

  useEffect(() => {
    if (!availabilitiesData?.data) return;
    hydrateFromApi(availabilitiesData.data);
  }, [availabilitiesData]);

  const addSlot = (day: string) => {
    setSlots((prev) => ({
      ...prev,
      [day]: [
        ...(prev[day] || []),
        { localId: `${day}-${Date.now()}`, start: "14:00", end: "17:00" },
      ],
    }));
  };

  const removeSlot = (day: string, localId: string) => {
    setSlots((prev) => {
      const target = (prev[day] || []).find((s) => s.localId === localId);
      if (target?.id) {
        setRemovedSlotIds((old) =>
          old.includes(target.id as number)
            ? old
            : [...old, target.id as number],
        );
      }
      return {
        ...prev,
        [day]: (prev[day] || []).filter((s) => s.localId !== localId),
      };
    });
  };

  const hasChanges =
    initialSignature !==
    signatureFor(duration, enabledDays, slots, removedSlotIds);

  const handleSaveAvailability = async () => {
    setSaveError("");
    const slotDuration = Number.parseInt(duration, 10);
    const safeDuration = Number.isFinite(slotDuration) ? slotDuration : 30;
    const toHHMM = (v: string) => {
      const trimmed = String(v || "").trim();
      const m = trimmed.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    };
    const toMinutes = (hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number);
      return h * 60 + m;
    };

    if (safeDuration < 15 || safeDuration > 480) {
      setSaveError("La durée doit être comprise entre 15 et 480 minutes.");
      return;
    }

    for (const day of WEEK_DAYS) {
      const daySlots = slots[day] || [];
      for (const slot of daySlots) {
        const start = toHHMM(slot.start);
        const end = toHHMM(slot.end);
        if (!start || !end) {
          setSaveError(
            `Format horaire invalide (${day}). Utilisez HH:MM, ex: 09:00.`,
          );
          return;
        }
        if (toMinutes(start) >= toMinutes(end)) {
          setSaveError(
            `Heure de début doit être avant l'heure de fin (${day}).`,
          );
          return;
        }
      }
    }

    try {
      for (const id of removedSlotIds) {
        await deleteAvailability(id).unwrap();
      }
      for (const day of WEEK_DAYS) {
        const enabled = !!enabledDays[day];
        const daySlots = slots[day] || [];
        for (const slot of daySlots) {
          const normalizedStart = toHHMM(slot.start) as string;
          const normalizedEnd = toHHMM(slot.end) as string;
          if (slot.id) {
            const initial = initialSlotsById[slot.id];
            const unchanged =
              !!initial &&
              initial.start === normalizedStart &&
              initial.end === normalizedEnd &&
              initial.slotDuration === safeDuration &&
              initial.isActive === enabled;
            if (unchanged) continue;
            await updateAvailability({
              id: slot.id,
              body: {
                startTime: normalizedStart,
                endTime: normalizedEnd,
                slotDuration: safeDuration,
                isActive: enabled,
              },
            }).unwrap();
          } else if (enabled) {
            await createAvailability({
              isRecurring: true,
              dayOfWeek: DAY_FR_TO_API[day],
              startTime: normalizedStart,
              endTime: normalizedEnd,
              slotDuration: safeDuration,
            }).unwrap();
          }
        }
      }
      await refetchAvailabilities();
    } catch (e: any) {
      const backendMessage =
        e?.data?.message ||
        e?.error ||
        "Échec d'enregistrement des disponibilités.";
      setSaveError(
        Array.isArray(backendMessage)
          ? backendMessage.join(" | ")
          : String(backendMessage),
      );
    }
  };

  const handleCreateLeave = async () => {
    setSaveError("");
    if (!vacationStart || !vacationEnd) return;
    try {
      await createLeave({
        startDate: vacationStart,
        endDate: vacationEnd,
        reason: vacationReason.trim() || undefined,
      }).unwrap();
      setVacationStart("");
      setVacationEnd("");
      setVacationReason("");
      setVacationEnabled(false);
      await refetchLeaves();
    } catch (e: any) {
      const backendMessage =
        e?.data?.message || e?.error || "Échec de création du congé.";
      setSaveError(
        Array.isArray(backendMessage)
          ? backendMessage.join(" | ")
          : String(backendMessage),
      );
    }
  };

  const handleDeleteLeave = async (id: number) => {
    setSaveError("");
    try {
      await deleteLeave(id).unwrap();
      await refetchLeaves();
    } catch (e: any) {
      const backendMessage =
        e?.data?.message || e?.error || "Échec de suppression du congé.";
      setSaveError(
        Array.isArray(backendMessage)
          ? backendMessage.join(" | ")
          : String(backendMessage),
      );
    }
  };

  if (isLoadingAvailabilities) {
    return (
      <Box
        sx={{
          p: 3,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 1.5,
        }}
      >
        <CircularProgress size={22} />
        <Typography color="text.secondary">
          Chargement des disponibilités...
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ bgcolor: "white", borderRadius: 3, p: 2 }}>
      {saveError && (
        <Typography sx={{ mb: 1 }} variant="caption" color="error.main">
          {saveError}
        </Typography>
      )}

      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Durée du rendez-vous
        </Typography>
        <CustomInput
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          placeholder="30 minutes"
        />
        <Typography variant="caption" color="text.secondary">
          Les clients pourront réserver par créneaux de {duration || "30"}{" "}
          minutes.
        </Typography>
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
        {WEEK_DAYS.map((day) => (
          <Box
            key={day}
            sx={{ borderTop: "1px solid", borderColor: "divider", pt: 1.5 }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                mb: 1,
              }}
            >
              <Typography variant="subtitle2">{day}</Typography>
              <Switch
                checked={!!enabledDays[day]}
                onChange={(_, checked) =>
                  setEnabledDays((prev) => ({ ...prev, [day]: checked }))
                }
              />
            </Box>
            {enabledDays[day] && (
              <>
                {(slots[day] || []).map((slot, idx) => (
                  <Box
                    key={slot.localId}
                    sx={{
                      display: "flex",
                      gap: 1,
                      alignItems: "center",
                      mb: 1,
                    }}
                  >
                    <CustomInput
                      value={slot.start}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSlots((prev) => ({
                          ...prev,
                          [day]: prev[day].map((s, i) =>
                            i === idx ? { ...s, start: v } : s,
                          ),
                        }));
                      }}
                    />
                    <Typography variant="body2" color="text.secondary">
                      à
                    </Typography>
                    <CustomInput
                      value={slot.end}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSlots((prev) => ({
                          ...prev,
                          [day]: prev[day].map((s, i) =>
                            i === idx ? { ...s, end: v } : s,
                          ),
                        }));
                      }}
                    />
                    <IconButton
                      aria-label={`Supprimer le créneau ${idx + 1}`}
                      size="small"
                      onClick={() => removeSlot(day, slot.localId)}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </Box>
                ))}
                <CustomButton
                  variant="contained"
                  fullWidth
                  startIcon={<Plus size={16} />}
                  onClick={() => addSlot(day)}
                >
                  Ajouter un créneau
                </CustomButton>
              </>
            )}
          </Box>
        ))}
      </Box>

      <Box sx={{ borderTop: "1px solid", borderColor: "divider", pt: 1.5 }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            mb: 1,
          }}
        >
          <Typography variant="subtitle2">Période de congé</Typography>

          <Switch
            checked={vacationEnabled}
            onChange={(_, checked) => setVacationEnabled(checked)}
          />
        </Box>

        {vacationEnabled && (
          <Box
            sx={{
              display: "flex",
              gap: 1.5,
              alignItems: "flex-start",
              mb: 1,
            }}
          >
            <CustomInput
              label="Date début"
              type="date"
              value={vacationStart}
              onChange={(e) => setVacationStart(e.target.value)}
            />

            <CustomInput
              label="Date fin"
              type="date"
              value={vacationEnd}
              onChange={(e) => setVacationEnd(e.target.value)}
            />

            <Box sx={{ flex: 1, minWidth: 240 }}>
              <CustomInput
                label="Raison (optionnel)"
                value={vacationReason}
                onChange={(e) => setVacationReason(e.target.value)}
                placeholder="Ex: mission / formation / etc."
              />
            </Box>

            <CustomButton
              variant="contained"
              onClick={handleCreateLeave}
              disabled={!vacationStart || !vacationEnd || isCreatingLeave}
              size="large"
            >
              <Check size={16} />
            </CustomButton>
          </Box>
        )}

        <Box sx={{ mt: vacationEnabled ? 0 : 1 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Mes congés
          </Typography>

          {leaves.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              Aucun congé déclaré.
            </Typography>
          ) : (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {leaves.map((l) => {
                const start = l.startDate
                  ? new Date(l.startDate).toLocaleDateString("fr-FR")
                  : "";
                const end = l.endDate
                  ? new Date(l.endDate).toLocaleDateString("fr-FR")
                  : "";
                return (
                  <Box
                    key={l.id}
                    sx={{
                      p: 1.25,
                      border: "1px solid",
                      borderColor: "divider",
                      borderRadius: 2,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 1.5,
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={600} noWrap>
                        {start && end ? `${start} - ${end}` : "Congé"}
                      </Typography>
                      {l.reason ? (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: "block", mt: 0.25 }}
                          noWrap
                        >
                          {l.reason}
                        </Typography>
                      ) : null}
                    </Box>

                    <IconButton
                      size="small"
                      onClick={() => handleDeleteLeave(l.id)}
                      disabled={isDeletingLeave}
                      aria-label={`Supprimer le congé ${l.id}`}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      </Box>

      <Box sx={{ mt: 2, display: "flex", justifyContent: "flex-end" }}>
        <CustomButton
          variant="contained"
          onClick={handleSaveAvailability}
          disabled={!hasChanges || isSavingAvailability}
        >
          Enregistrer
        </CustomButton>
      </Box>
    </Box>
  );
}

// ─── MeetingsView ─────────────────────────────────────────────────────────────

export default function MeetingsView() {
  const [mode, setMode] = useState<Mode>("appointments");
  const [tab, setTab] = useState<TimeTab>("today");
  const ROWS_PER_PAGE = 5;
  const [page, setPage] = useState(0);
  const { id: routeId } = useParams<{ id: string }>();
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const parsed = routeId ? parseInt(routeId, 10) : NaN;
    return isNaN(parsed) ? null : parsed;
  });
  useEffect(() => {
    if (!routeId) return;
    const parsed = parseInt(routeId, 10);
    if (!isNaN(parsed)) {
      setSelectedId(parsed);
    }
  }, [routeId]);
  const [selectedAppointmentSnapshot, setSelectedAppointmentSnapshot] =
    useState<AppointmentItem | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectAppointment, setRejectAppointment] =
    useState<AppointmentItem | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardMode, setWizardMode] = useState<"create" | "report">("create");
  const [wizardInitialValues, setWizardInitialValues] = useState<any>();
  const [reportAppointmentId, setReportAppointmentId] = useState<
    number | undefined
  >(undefined);
  const [wizardReportReason, setWizardReportReason] = useState<string>("");
  const [calendarMonth] = useState(new Date());
  const [search, setSearch] = useState("");
  const theme = useTheme();
  const { data: me } = useVerifyUserQuery();
  const roleCode = getUserRoleCode(me);
  const isClient = roleCode === "CLIENT";
  const isAccountant = roleCode === "ACCOUNTANT" || roleCode === "COMPTABLE";
  const rawMeId = me?.id != null ? Number(me.id) : NaN;
  const meId =
    Number.isInteger(rawMeId) && Number.isFinite(rawMeId) && rawMeId > 0
      ? rawMeId
      : undefined;
  const { data: clientsData, isLoading: isLoadingClients } = useGetClientsQuery(
    {
      page: 1,
      limit: 200,
    },
    { skip: isClient },
  );
  const { data: myAccountantsData } = useGetMyAccountantsQuery(undefined, {
    skip: !isClient,
  });
  const linkedAccountantId =
    isClient && Array.isArray(myAccountantsData?.data)
      ? (myAccountantsData.data.find((a) => a?.id != null)?.id ?? undefined)
      : undefined;

  const searchTerm = search.trim();
  useEffect(() => {
    setPage(0);
  }, [tab, searchTerm]);

  const queryParams: {
    page: number;
    limit: number;
    period: TimeTab;
    search: string | undefined;
  } = {
    page: page + 1,
    limit: ROWS_PER_PAGE,
    period: tab,
    search: searchTerm || undefined,
  };
  const { data: accountantAppointmentsData, isLoading: isLoadingAll } =
    useGetAllAppointmentsQuery(queryParams, { skip: isClient });
  const { data: myAppointmentsData, isLoading: isLoadingMine } =
    useGetMyAppointmentsQuery(queryParams, { skip: !isClient });
  const data = isClient ? myAppointmentsData : accountantAppointmentsData;
  const isLoading = isClient ? isLoadingMine : isLoadingAll;
  const appointments = data?.data ?? [];
  const { data: confirmedThisMonthData } = useGetConfirmedThisMonthQuery();
  const calendarAppointments = confirmedThisMonthData?.data ?? [];

  const todayParams: {
    page: number;
    limit: number;
    period: TimeTab;
    search: string | undefined;
  } = {
    page: 1,
    limit: 1,
    period: "today",
    search: searchTerm || undefined,
  };
  const upcomingParams: {
    page: number;
    limit: number;
    period: TimeTab;
    search: string | undefined;
  } = {
    page: 1,
    limit: 1,
    period: "upcoming",
    search: searchTerm || undefined,
  };
  const pastParams: {
    page: number;
    limit: number;
    period: TimeTab;
    search: string | undefined;
  } = {
    page: 1,
    limit: 1,
    period: "past",
    search: searchTerm || undefined,
  };

  const { data: todayAllData } = useGetAllAppointmentsQuery(todayParams, {
    skip: isClient,
  });
  const { data: upcomingAllData } = useGetAllAppointmentsQuery(upcomingParams, {
    skip: isClient,
  });
  const { data: pastAllData } = useGetAllAppointmentsQuery(pastParams, {
    skip: isClient,
  });
  const { data: todayMineData } = useGetMyAppointmentsQuery(todayParams, {
    skip: !isClient,
  });
  const { data: upcomingMineData } = useGetMyAppointmentsQuery(upcomingParams, {
    skip: !isClient,
  });
  const { data: pastMineData } = useGetMyAppointmentsQuery(pastParams, {
    skip: !isClient,
  });

  const todayCountData = isClient ? todayMineData : todayAllData;
  const upcomingCountData = isClient ? upcomingMineData : upcomingAllData;
  const pastCountData = isClient ? pastMineData : pastAllData;
  const counts = useMemo(
    () => ({
      today: todayCountData?.pagination?.total ?? 0,
      upcoming: upcomingCountData?.pagination?.total ?? 0,
      past: pastCountData?.pagination?.total ?? 0,
    }),
    [todayCountData, upcomingCountData, pastCountData],
  );

  const { data: detailsData } = useGetAppointmentByIdQuery(selectedId!, {
    skip: selectedId == null,
    refetchOnMountOrArgChange: true,
  });
  const appointment = detailsData?.data ?? selectedAppointmentSnapshot ?? null;

  useEffect(() => {
    if (!detailsData?.data || selectedId == null) return;
    if (detailsData.data.id !== selectedId) return;
    setSelectedAppointmentSnapshot(detailsData.data);
  }, [detailsData, selectedId]);

  const [respondAppointment] = useRespondAppointmentMutation();
  const [createAppointment] = useCreateAppointmentMutation();
  const [reportAppointment] = useReportAppointmentMutation();
  const [cancelAppointment] = useCancelAppointmentMutation();
  const [updateAppointment] = useUpdateAppointmentMutation();
  const headerActions = [
    {
      label: "Nouveau RDV",
      icon: <Plus size={16} />,
      onClick: () => {
        setWizardMode("create");
        setWizardInitialValues(undefined);
        setReportAppointmentId(undefined);
        setWizardReportReason("");
        setWizardOpen(true);
      },
      variant: "contained" as const,
      color: "primary" as const,
    },
    ...(isAccountant
      ? [
          {
            label: "Mes disponibilités",
            onClick: () => setMode("availability"),
            variant: "contained" as const,
            color: "secondary" as const,
          },
        ]
      : []),
  ];

  const handleConfirm = async () => {
    if (!selectedId || !appointment) return;
    if (isAccountant) {
      await respondAppointment({ id: selectedId, action: "confirm" }).unwrap();
      return;
    }
    await updateAppointment({
      id: selectedId,
      body: { status: "confirmed" },
    }).unwrap();
  };

  const openReportWizardFromAppointment = (item: any, reason?: string) => {
    const start = new Date(item.startTime);
    const base = Number.isNaN(start.getTime()) ? new Date() : start;
    const next = new Date(base);
    next.setDate(base.getDate() + 1);

    setWizardReportReason(reason ?? "");
    setWizardMode("report");
    setReportAppointmentId(item.id);
    setWizardInitialValues({
      title: item.title,
      subject: deriveSubjectFromAppointment(item),
      description: item.description ?? "",
      date: toDateInputValue(next),
      time: "",
      meetingType: item.meetingType,
      location: item.location ?? "",
      guests: item.guests ?? [],
      clientId: item.client?.id,
      color: item.color ?? null,
    });
    setWizardOpen(true);
  };

  const canActOnPending = (item: any) => {
    if (!item || meId == null) return false;
    const creatorId =
      item.createdById != null ? Number(item.createdById) : undefined;
    if (!creatorId || !Number.isFinite(creatorId)) return true;
    return creatorId !== meId;
  };

  const canActOnReport = (item: any) => {
    if (!item || meId == null) return false;
    const updaterId =
      item.updatedById != null ? Number(item.updatedById) : undefined;
    if (updaterId && Number.isFinite(updaterId)) return updaterId !== meId;
    const creatorId =
      item.createdById != null ? Number(item.createdById) : undefined;
    if (creatorId && Number.isFinite(creatorId)) return creatorId !== meId;
    return true;
  };

  const handleRejectCancel = async () => {
    if (!rejectAppointment) return;
    await respondAppointment({
      id: rejectAppointment.id,
      action: "reject",
      rejectionReason: rejectReason.trim() || undefined,
    }).unwrap();
    closeRejectModal();
  };

  const handleCancelConfirmed = async () => {
    if (!selectedId) return;
    await cancelAppointment(selectedId).unwrap();
  };

  const handleRejectReport = async () => {
    if (!rejectAppointment) return;
    openReportWizardFromAppointment(rejectAppointment, rejectReason);
    closeRejectModal();
  };

  const [touched, setTouched] = useState(false);
  const handleInputBlur = () => setTouched(true);
  const closeRejectModal = () => {
    setRejectDialogOpen(false);
    setRejectReason("");
    setTouched(false);
    setRejectAppointment(null);
  };

  if (mode === "availability") {
    return (
      <PageHeader
        title="Mes disponibilités"
        caption="Configurez vos créneaux horaires hebdomadaires."
        backButton={() => setMode("appointments")}
      >
        <AvailabilitySettings />
      </PageHeader>
    );
  }

  return (
    <PageHeader
      title="Mes Rendez-vous"
      caption="Gérez vos réunions, confirmez ou refusez les demandes, et consultez les détails."
      actions={headerActions}
    >
      <Box mt={2}>
        <FolderTabNavigation
          activeTab={tab}
          onTabChange={(id) => setTab(id as TimeTab)}
          tabs={[
            { id: "today", label: "Aujourd'hui", count: counts.today },
            { id: "upcoming", label: "À venir", count: counts.upcoming },
            { id: "past", label: "Passé", count: counts.past },
          ]}
        />

        <Box
          sx={{
            backgroundColor: theme.palette.common.white,
            borderRadius: "0 12px 12px 12px",
            p: 2,
          }}
        >
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
            <CustomInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher par client ..."
              startIcon={<Search />}
              fullWidth
            />
            {isLoading ? (
              <Typography color="text.secondary">Chargement...</Typography>
            ) : appointments.length === 0 ? (
              <Typography color="text.secondary">Aucun rendez-vous.</Typography>
            ) : (
              appointments.map((item) => (
                <AppointmentCard
                  key={item.id}
                  appointment={item}
                  period={tab}
                  canConfirmReject={canActOnPending(item)}
                  canReschedule={canActOnReport(item)}
                  onClick={() => {
                    setSelectedAppointmentSnapshot(item);
                    setSelectedId(item.id);
                  }}
                  onConfirm={async () => {
                    if (isAccountant) {
                      await respondAppointment({
                        id: item.id,
                        action: "confirm",
                      }).unwrap();
                    } else {
                      await updateAppointment({
                        id: item.id,
                        body: { status: "confirmed" },
                      }).unwrap();
                    }
                  }}
                  onReject={() => {
                    setRejectAppointment(item);
                    setRejectDialogOpen(true);
                  }}
                  onReschedule={() => {
                    setSelectedAppointmentSnapshot(item);
                    openReportWizardFromAppointment(item);
                  }}
                />
              ))
            )}
          </Box>

          {counts[tab] > ROWS_PER_PAGE && (
            <Box sx={{ mt: 2 }}>
              <CustomPagination
                page={page}
                count={counts[tab]}
                rowsPerPage={ROWS_PER_PAGE}
                onPageChange={(_event, newPage) => setPage(newPage)}
              />
            </Box>
          )}

          <Box sx={{ mt: 3 }}>
            <Typography variant="h6" sx={{ mb: 1.25 }}>
              {formatMonthLabelFr(calendarMonth)}
            </Typography>
            <MonthlyAppointmentCalendar
              monthDate={calendarMonth}
              appointments={calendarAppointments}
              onSelectAppointment={(id) => {
                const fromCalendar =
                  calendarAppointments.find((a) => a.id === id) ?? null;
                setSelectedAppointmentSnapshot(fromCalendar);
                setSelectedId(id);
              }}
            />
          </Box>
        </Box>
      </Box>

      <AppointmentDetailsDialog
        open={selectedId != null && appointment != null}
        appointment={appointment}
        canConfirmReject={canActOnPending(appointment)}
        canReport={canActOnReport(appointment)}
        onClose={() => {
          setSelectedId(null);
          setSelectedAppointmentSnapshot(null);
        }}
        onConfirm={handleConfirm}
        onReject={() => {
          if (appointment) {
            setRejectAppointment(appointment);
            setRejectDialogOpen(true);
          }
        }}
        onCancel={handleCancelConfirmed}
        onReport={() => {
          if (!appointment) return;
          openReportWizardFromAppointment(appointment);
        }}
      />

      <Dialog
        open={rejectDialogOpen}
        onClose={closeRejectModal}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Typography variant="h6" component="div" sx={{ fontWeight: 600 }}>
            Refuser la réunion
          </Typography>
          <IconButton
            aria-label="close"
            onClick={closeRejectModal}
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <X />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ pt: 2 }}>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <Typography variant="body1">
              Êtes-vous sûr de vouloir refuser cette réunion ?
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Une raison est requise pour justifier le refus.
            </Typography>
            <CustomInput
              multiline
              minRows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              onBlur={handleInputBlur}
              placeholder="Ex: conflit d'horaire, indisponibilité, sujet déjà traité..."
              fullWidth
              required
              error={!rejectReason.trim() && touched}
              helperText={
                !rejectReason.trim() && touched
                  ? "Veuillez saisir une raison"
                  : ""
              }
              sx={{ mt: 1 }}
            />
          </Box>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: "space-between", gap: 1 }}>
          <CustomButton
            variant="outlined"
            color="info"
            sx={{ color: theme.palette.info.darker }}
            onClick={closeRejectModal}
          >
            Annuler
          </CustomButton>
          <Box sx={{ display: "flex", gap: 1 }}>
            <CustomButton
              variant="contained"
              color="warning"
              onClick={handleRejectReport}
            >
              Reporter
            </CustomButton>
            <CustomButton
              variant="contained"
              color="error"
              onClick={handleRejectCancel}
            >
              Refuser définitivement
            </CustomButton>
          </Box>
        </DialogActions>
      </Dialog>

      <Drawer
        anchor="right"
        open={wizardOpen}
        onClose={() => {
          setWizardOpen(false);
          setWizardMode("create");
          setWizardInitialValues(undefined);
          setReportAppointmentId(undefined);
          setWizardReportReason("");
        }}
        sx={{ zIndex: (theme2) => theme2.zIndex.modal + 10 }}
        slotProps={{
          paper: {
            sx: {
              width: { xs: "95%", sm: 520 },
              height: "calc(100% - 32px)",
              top: "16px",
              right: { xs: "13px", sm: "16px" },
              borderRadius: 3,
              overflow: "hidden",
            },
          },
        }}
      >
        <NewAppointmentWizard
          open={wizardOpen}
          onClose={() => {
            setWizardOpen(false);
            setWizardMode("create");
            setWizardInitialValues(undefined);
            setReportAppointmentId(undefined);
            setWizardReportReason("");
          }}
          mode={wizardMode}
          initialValues={wizardInitialValues}
          reportAppointmentId={reportAppointmentId}
          fixedClientId={isClient ? meId : undefined}
          reportReason={wizardReportReason}
          onSchedule={async (payload) => {
            await createAppointment({
              title: payload.title,
              description: payload.description,
              type:
                payload.subject === "facturation"
                  ? "review"
                  : payload.subject === "budget"
                    ? "consultation"
                    : "consultation",
              date: payload.date,
              hour: payload.time,
              meetingType: payload.meetingType,
              location: payload.location,
              accountantId: isClient ? linkedAccountantId : meId,
              clientId: payload.clientId,
              clientNotes: payload.guests.length
                ? `Invités: ${payload.guests.join(", ")}`
                : payload.description,
              color: payload.color,
              guests: payload.guests,
            }).unwrap();
          }}
          onReport={async (payload) => {
            await reportAppointment({
              id: payload.id,
              newDate: payload.newDate,
              newHour: payload.newHour,
              reason: payload.reason,
            }).unwrap();
          }}
          clients={clientsData?.data ?? []}
          clientsLoading={isLoadingClients}
          accountantId={isClient ? linkedAccountantId : meId}
        />
      </Drawer>
    </PageHeader>
  );
}
