import { useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";

import CustomButton from "../../../../components/common/CustomButton";
import SpreadsheetTable from "./SpreadsheetTable";
import { useSpreadsheetPreview } from "../hooks/useSpreadsheetPreview";
import { useDocxPreview } from "../hooks/useDocxPreview";
import type { SharedMediaFile } from "../data/types";

// ── CSV mini-table (PapaParse) ────────────────────────────────────────────────
function CsvTablePreview({ url }: { url: string }) {
  const state = useSpreadsheetPreview(url, true, 3, 4, true); // max 3 rows for card

  if (state.status === "loading" || state.status === "idle") {
    return <CircularProgress size={14} sx={{ color: "#16A34A" }} />;
  }
  if (state.status === "error") {
    return <TableChartOutlinedIcon sx={{ fontSize: 26, color: "#16A34A" }} />;
  }
  return (
    <SpreadsheetTable
      headers={state.headers}
      rows={state.rows}
      variant="compact"
    />
  );
}

// ── DOCX card thumbnail — first ~200 chars of converted HTML ─────────────────
function DocxCardPreview({ url }: { url: string }) {
  const state = useDocxPreview(url, true);

  if (state.status === "loading" || state.status === "idle") {
    return <CircularProgress size={14} sx={{ color: "#2563EB" }} />;
  }
  if (state.status === "error" || !state.html) {
    return <DescriptionOutlinedIcon sx={{ fontSize: 26, color: "#2563EB" }} />;
  }

  return (
    <Box
      sx={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        p: "4px",
        backgroundColor: "#EFF6FF",
      }}
    >
      <Box
        sx={{
          fontSize: 5.5,
          lineHeight: 1.4,
          color: "#1E3A5F",
          overflow: "hidden",
          height: "100%",
          "& p, & h1, & h2, & h3, & li": { margin: 0, padding: 0 },
        }}
        dangerouslySetInnerHTML={{ __html: state.html }}
      />
    </Box>
  );
}

// ── XLS/XLSX card thumbnail ───────────────────────────────────────────────────
function XlsxCardPreview({ url }: { url: string }) {
  const state = useSpreadsheetPreview(url, true, 6, 4, false);

  if (state.status === "loading" || state.status === "idle") {
    return <CircularProgress size={14} sx={{ color: "#16A34A" }} />;
  }
  if (state.status === "error") {
    return <TableChartOutlinedIcon sx={{ fontSize: 26, color: "#16A34A" }} />;
  }
  return (
    <SpreadsheetTable
      headers={state.headers}
      rows={state.rows}
      variant="compact"
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────

type SharedMediaCardProps = {
  file: SharedMediaFile;
  onView: (file: SharedMediaFile) => void;
  onImageError?: () => void;
};

export default function SharedMediaCard({
  file,
  onView,
  onImageError,
}: SharedMediaCardProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const [imgFailed, setImgFailed] = useState(false);
  const canDownload = !!file.previewUrl && file.previewUrl !== "#";

  const isXlsx = file.type === "xls" && /\.(xls|xlsx)$/i.test(file.name);
  const isCsv = file.type === "xls" && /\.csv$/i.test(file.name);
  const isDocx = file.type === "doc" && /\.docx$/i.test(file.name);
  const isLegacyDoc =
    file.type === "doc" && /\.doc$/i.test(file.name) && !isDocx;

  const handleDownload = async () => {
    if (!canDownload || !file.previewUrl) return;
    try {
      const res = await fetch(file.previewUrl);
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(file.previewUrl, "_blank", "noopener,noreferrer");
    }
  };

  const renderPreview = () => {
    // Image
    if (file.type === "image") {
      if (file.previewUrl && !imgFailed) {
        return (
          <Box
            component="img"
            src={file.previewUrl}
            alt={file.name}
            onError={() => {
              setImgFailed(true);
              onImageError?.();
            }}
            sx={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        );
      }
      return <ImageOutlinedIcon sx={{ fontSize: 26, color: "#64748B" }} />;
    }

    // PDF — iframe thumbnail
    if (file.type === "pdf") {
      if (file.previewUrl) {
        return (
          <Box
            component="iframe"
            src={`${file.previewUrl}#toolbar=0&navpanes=0&view=FitH`}
            title={file.name}
            sx={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "calc(300% + 20px)",
              height: "calc(300% + 20px)",
              border: "none",
              pointerEvents: "none",
              transform: "scale(0.333)",
              transformOrigin: "0 0",
              backgroundColor: "#fff",
            }}
          />
        );
      }
      return (
        <PictureAsPdfOutlinedIcon sx={{ fontSize: 26, color: "#F04438" }} />
      );
    }

    // DOCX — real mammoth preview
    if (isDocx && file.previewUrl) {
      return <DocxCardPreview url={file.previewUrl} />;
    }

    // Legacy .doc — honest icon (mammoth cannot parse binary .doc)
    if (isLegacyDoc) {
      return (
        <DescriptionOutlinedIcon sx={{ fontSize: 26, color: "#2563EB" }} />
      );
    }

    // Generic doc fallback
    if (file.type === "doc") {
      return (
        <DescriptionOutlinedIcon sx={{ fontSize: 26, color: "#2563EB" }} />
      );
    }

    // XLS/XLSX — real SheetJS preview
    if (isXlsx && file.previewUrl) {
      return <XlsxCardPreview url={file.previewUrl} />;
    }

    // CSV — plain text parse
    if (isCsv && file.previewUrl) {
      return <CsvTablePreview url={file.previewUrl} />;
    }

    // Generic xls fallback
    if (file.type === "xls") {
      return <TableChartOutlinedIcon sx={{ fontSize: 26, color: "#16A34A" }} />;
    }

    return (
      <InsertDriveFileOutlinedIcon sx={{ fontSize: 26, color: "#64748B" }} />
    );
  };

  return (
    <Paper
      elevation={0}
      sx={{
        width: "100%",
        minWidth: 0,
        height: isMobile ? "auto" : 182,
        p: isMobile ? 1 : 0.75,
        borderRadius: "14px",
        border: "1px solid #ECECEC",
        backgroundColor: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        boxShadow: "none",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          width: "100%",
          height: isMobile ? 110 : 96,
          borderRadius: "10px",
          overflow: "hidden",
          backgroundColor: "#F8F9FB",
          border: "1px solid #F1F1F1",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          mb: isMobile ? 1 : 0.7,
          position: "relative",
        }}
      >
        {renderPreview()}
      </Box>

      <Box sx={{ minWidth: 0, flexShrink: 0, mb: isMobile ? 1 : 0.7 }}>
        <Typography
          noWrap
          title={file.name}
          sx={{
            fontSize: isMobile ? 12 : 11.5,
            fontWeight: 500,
            color: "#1F2937",
            lineHeight: 1.3,
          }}
        >
          {file.name}
        </Typography>
        <Typography
          noWrap
          sx={{
            mt: 0.25,
            fontSize: isMobile ? 10.5 : 10,
            color: "#98A2B3",
            lineHeight: 1.3,
          }}
        >
          {file.uploadedAt}
        </Typography>
      </Box>

      <Box
        sx={{
          mt: "auto",
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          alignItems: "stretch",
          gap: isMobile ? 0.5 : 0.55,
          flexShrink: 0,
        }}
      >
        <CustomButton
          fullWidth
          variant="outlined"
          color="secondary"
          onClick={handleDownload}
          startIcon={
            <DownloadOutlinedIcon sx={{ fontSize: isMobile ? 12 : 11 }} />
          }
          sx={{
            flex: 1,
            height: isMobile ? 30 : 24,
            minHeight: isMobile ? 30 : 24,
            minWidth: 0,
            px: isMobile ? 1 : 0.75,
            borderRadius: "8px",
            fontSize: isMobile ? 10 : 9,
            fontWeight: 500,
            borderColor: "#E4E7EC",
            color: "#344054",
            backgroundColor: "#FFFFFF",
            boxShadow: "none",
          }}
        >
          Télécharger
        </CustomButton>
        <CustomButton
          fullWidth
          variant="contained"
          color="primary"
          startIcon={
            <VisibilityOutlinedIcon sx={{ fontSize: isMobile ? 12 : 11 }} />
          }
          onClick={() => onView(file)}
          sx={{
            flex: 1,
            height: isMobile ? 30 : 24,
            minHeight: isMobile ? 30 : 24,
            minWidth: 0,
            px: isMobile ? 1 : 0.75,
            borderRadius: "8px",
            fontSize: isMobile ? 10 : 9,
            fontWeight: 500,
            boxShadow: "none",
          }}
        >
          Voir
        </CustomButton>
      </Box>
    </Paper>
  );
}
