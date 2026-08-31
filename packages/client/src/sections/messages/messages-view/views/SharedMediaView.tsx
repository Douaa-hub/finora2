import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import MenuItem from "@mui/material/MenuItem";
import CircularProgress from "@mui/material/CircularProgress";
import SearchIcon from "@mui/icons-material/Search";
import FilterListIcon from "@mui/icons-material/FilterList";
import ArrowBackIosNewIcon from "@mui/icons-material/ArrowBackIosNew";
import { useTheme } from "@mui/material/styles";

import CustomInput from "../../../../components/common/CustomInput";
import CustomSelect from "../../../../components/common/CustomSelect";

import { CustomPagination } from "src/layouts/components/table-pagination";

import {
  useGetSharedDocumentsQuery,
  type SharedDocument,
} from "src/lib/services/chatApi";
import type { SharedMediaFile } from "../data/types";
import SharedMediaCard from "../components/SharedMediaCard";
import SharedMediaPreviewModal from "../components/SharedMediaPreviewModal";

type SharedMediaViewProps = {
  conversationId: number;
  onBack?: () => void;
};

type FilterType = "all" | "pdf" | "image" | "doc" | "xls";

const ITEMS_PER_PAGE = 10;

function getFileCategory(
  fileName: string,
  docType?: string,
): SharedMediaFile["type"] {
  if (docType === "image") return "image";

  const lower = fileName.toLowerCase();

  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(lower)) return "image";
  if (lower.endsWith(".pdf")) return "pdf";
  if (/\.docx?$/.test(lower)) return "doc";
  if (/\.(xlsx?|csv)$/.test(lower)) return "xls";

  return "file"; // generic fallback
}

function formatUploadedAt(isoDate: string) {
  const d = new Date(isoDate);
  const datePart = d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
  });
  const timePart = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${datePart}, ${timePart}`;
}

function mapDocToMediaFile(doc: SharedDocument): SharedMediaFile {
  const fileName = doc.content.split("/").pop() || doc.content || "Fichier";
  return {
    id: doc.id,
    name: fileName,
    type: getFileCategory(fileName, doc.type),
    size: "",
    uploadedAt: formatUploadedAt(doc.createdAt),
    previewUrl: doc.fileUrl ?? undefined,
  };
}

export default function SharedMediaView({
  conversationId,
  onBack,
}: SharedMediaViewProps) {
  const theme = useTheme();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedType, setSelectedType] = useState<FilterType>("all");
  const [page, setPage] = useState(1);
  const [previewedFile, setPreviewedFile] = useState<SharedMediaFile | null>(
    null,
  );
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  // Track files whose image URL failed to load at runtime
  const [erroredIds, setErroredIds] = useState<Set<number>>(new Set());

  const { isLoading, isFetching, currentData } = useGetSharedDocumentsQuery(
    { roomId: conversationId, pageSize: 100 },
    { skip: !conversationId },
  );

  // Use currentData (only set when the query is for the current roomId) to avoid
  // briefly showing documents from another room while the new query is loading.
  const allFiles = useMemo<SharedMediaFile[]>(() => {
    if (!currentData?.data) return [];
    return currentData.data.map(mapDocToMediaFile);
  }, [currentData]);

  const handleImageError = useCallback((id: number) => {
    setErroredIds((prev) => new Set([...prev, id]));
  }, []);

  // Reset errored IDs when the conversation changes
  useEffect(() => {
    setErroredIds(new Set());
  }, [conversationId]);

  const filteredFiles = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    return allFiles.filter((file) => {
      // Exclude old/broken files that have no usable file URL
      if (!file.previewUrl) return false;

      const matchesType = selectedType === "all" || file.type === selectedType;
      const matchesSearch =
        !normalizedSearch || file.name.toLowerCase().includes(normalizedSearch);
      return matchesType && matchesSearch;
    });
  }, [allFiles, searchTerm, selectedType, erroredIds]);

  useEffect(() => {
    setPage(1);
  }, [searchTerm, selectedType, conversationId]);

  // Ne remet PAS la page à 1 : ramène seulement `page` vers la dernière
  // page encore valide si le nombre de fichiers filtrés a diminué sous la
  // page courante (ex. des images retirées de erroredIds) — sans jamais
  // avancer `page` ni interférer avec le reset ci-dessus.
  useEffect(() => {
    const totalPages = Math.max(
      1,
      Math.ceil(filteredFiles.length / ITEMS_PER_PAGE),
    );
    setPage((prev) => Math.min(prev, totalPages));
  }, [filteredFiles]);

  const paginatedFiles = useMemo(() => {
    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    return filteredFiles.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [filteredFiles, page]);

  const handleOpenPreview = (file: SharedMediaFile) => {
    setPreviewedFile(file);
    setIsPreviewOpen(true);
  };

  const handleClosePreview = () => {
    setIsPreviewOpen(false);
    setPreviewedFile(null);
  };

  return (
    <>
      <Paper
        elevation={0}
        sx={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          borderRadius: "18px",
          border: "1px solid",
          borderColor: theme.palette.grey[200],
          backgroundColor: theme.palette.common.white,
          overflow: "hidden",
        }}
      >
        <Box
          sx={{
            px: { xs: 1.5, md: 2 },
            py: 1,
            borderBottom: "1px solid",
            borderColor: theme.palette.grey[200],
            flexShrink: 0,
          }}
        >
          <Box
            sx={{
              display: "flex",
              flexDirection: { xs: "column", md: "row" },
              alignItems: { xs: "flex-start", md: "center" },
              justifyContent: { xs: "flex-start", md: "space-between" },
              gap: { xs: 0.75, md: 2 },
            }}
          >
            <Box
              onClick={onBack}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.6,
                minWidth: 0,
                cursor: "pointer",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              <ArrowBackIosNewIcon
                sx={{
                  fontSize: 13,
                  color: theme.palette.info.main,
                  flexShrink: 0,
                }}
              />

              <Typography
                sx={{
                  fontSize: 13.5,
                  fontWeight: 500,
                  lineHeight: 1,
                  color: (theme.palette.grey as any)[1000],
                  whiteSpace: "nowrap",
                }}
              >
                Medias partagés
              </Typography>
            </Box>

            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                flexShrink: 0,
                width: { xs: "100%", md: "auto" },
              }}
            >
              <Box
                sx={{
                  width: { xs: "auto", md: 180 },
                  flex: { xs: 1, md: "none" },
                }}
              >
                <CustomInput
                  placeholder="Rechercher ..."
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  backgroundColor="#FFFFFF"
                  border
                  startIcon={
                    <SearchIcon
                      sx={{ fontSize: 14, color: theme.palette.info.light }}
                    />
                  }
                  sx={{
                    "& .MuiOutlinedInput-root": {
                      height: 30,
                      borderRadius: "6px",
                    },
                    "& .MuiOutlinedInput-notchedOutline": {
                      borderColor: theme.palette.grey[200],
                      borderWidth: "1px",
                    },
                    "& .MuiInputBase-input": {
                      fontSize: 10.5,
                      color: theme.palette.info.main,
                      py: 0,
                    },
                  }}
                />
              </Box>

              <Box
                sx={{
                  position: "relative",
                  width: { xs: 154, md: 132 },
                  flexShrink: 0,
                }}
              >
                <CustomSelect
                  label=""
                  value={selectedType}
                  onChange={(event) =>
                    setSelectedType(event.target.value as FilterType)
                  }
                  sx={{
                    "& .MuiInputLabel-root": {
                      display: "none",
                    },
                    "& .MuiOutlinedInput-root": {
                      height: 30,
                      borderRadius: "6px",
                      backgroundColor: "#FFFFFF",
                    },
                    "& .MuiOutlinedInput-notchedOutline": {
                      borderColor: theme.palette.grey[200],
                      borderWidth: "1px",
                    },
                    "& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline":
                      {
                        borderColor: theme.palette.grey[200],
                        borderWidth: "1px",
                      },
                    "& .MuiSelect-select": {
                      display: "flex",
                      alignItems: "center",
                      fontSize: 10.5,
                      fontWeight: 500,
                      color: theme.palette.info.main,
                      py: "0 !important",
                      pl: "26px !important",
                      pr: "28px !important",
                    },
                    "& .MuiSvgIcon-root": {
                      fontSize: 18,
                      color: theme.palette.info.light,
                    },
                  }}
                  MenuProps={{
                    PaperProps: {
                      sx: {
                        mt: 0.5,
                        borderRadius: "12px",
                        boxShadow: "0px 10px 30px rgba(15, 23, 42, 0.08)",
                        border: "1px solid #EEF1F4",
                        "& .MuiMenuItem-root": {
                          fontSize: 13,
                          color: "#111827",
                          minHeight: 40,
                        },
                      },
                    },
                  }}
                >
                  <MenuItem value="all">Tous les fichiers</MenuItem>
                  <MenuItem value="pdf">PDF</MenuItem>
                  <MenuItem value="image">Images</MenuItem>
                  <MenuItem value="doc">Documents</MenuItem>
                  <MenuItem value="xls">Tableurs</MenuItem>
                </CustomSelect>

                <Box
                  sx={{
                    position: "absolute",
                    top: "50%",
                    left: 8,
                    transform: "translateY(-50%)",
                    pointerEvents: "none",
                    display: "flex",
                    alignItems: "center",
                    zIndex: 1,
                  }}
                >
                  <FilterListIcon
                    sx={{ fontSize: 12, color: theme.palette.info.light }}
                  />
                </Box>
              </Box>
            </Box>
          </Box>
        </Box>

        {isLoading || isFetching ? (
          <Box
            sx={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CircularProgress size={28} />
          </Box>
        ) : filteredFiles.length === 0 ? (
          <Box
            sx={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              px: 3,
            }}
          >
            <Typography sx={{ fontSize: 13, color: theme.palette.info.light }}>
              Aucun fichier trouvé.
            </Typography>
          </Box>
        ) : (
          <>
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                px: { xs: 1.5, md: 2.25 },
                pt: { xs: 1.25, md: 1.5 },
                pb: { xs: 1, md: 1.1 },
                overflow: "hidden",
              }}
            >
              <Box
                sx={{
                  height: "100%",
                  overflowY: "auto",
                  pr: 0.5,
                  scrollbarWidth: "thin",
                  scrollbarColor: "#D0D5DD transparent",
                  "&::-webkit-scrollbar": {
                    width: 6,
                  },
                  "&::-webkit-scrollbar-thumb": {
                    backgroundColor: "#D0D5DD",
                    borderRadius: "999px",
                  },
                  "&::-webkit-scrollbar-track": {
                    backgroundColor: "transparent",
                  },
                }}
              >
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: {
                      xs: "repeat(2, minmax(0, 1fr))",
                      md: "repeat(4, minmax(0, 1fr))",
                    },
                    gridAutoRows: { xs: "auto", md: "176px" },
                    gap: { xs: 1.25, md: 1.5 },
                    alignItems: "stretch",
                    pb: 0.5,
                  }}
                >
                  {paginatedFiles.map((file) => (
                    <SharedMediaCard
                      key={file.id}
                      file={file}
                      onView={handleOpenPreview}
                      onImageError={() => handleImageError(file.id)}
                    />
                  ))}
                </Box>
              </Box>
            </Box>

            <Box
              sx={{
                flexShrink: 0,
                px: { xs: 1.5, md: 2.25 },
                py: 0,
                borderTop: "1px solid",
                borderColor: theme.palette.grey[200],
                backgroundColor: theme.palette.common.white,
                "& > .MuiBox-root": {
                  py: 0.75,
                  gap: { xs: 0.5, md: 0.75 },
                  minHeight: { xs: 46, md: 52 },
                },
                "& .MuiTypography-caption": {
                  ml: { xs: 0.75, md: 1.25 },
                  fontSize: { xs: 11, md: 12 },
                  lineHeight: 1.2,
                },
              }}
            >
              <CustomPagination
                page={page - 1}
                count={filteredFiles.length}
                rowsPerPage={ITEMS_PER_PAGE}
                onPageChange={(_, newPage) => setPage(newPage + 1)}
              />
            </Box>
          </>
        )}
      </Paper>

      <SharedMediaPreviewModal
        open={isPreviewOpen}
        file={previewedFile}
        onClose={handleClosePreview}
      />
    </>
  );
}
