import { useEffect, useRef, useCallback } from "react";
import {
  Box,
  Avatar,
  Typography,
  IconButton,
  useTheme,
  useMediaQuery,
  alpha,
  Tooltip,
  Alert,
} from "@mui/material";
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  Minimize2,
  Users,
} from "lucide-react";
import { useGlobalCall } from "src/contexts/GlobalCallContext";
import AudioVisualizer from "src/components/call/AudioVisualizer";
import { RINGTONE_CONFIG } from "src/components/call/ringtone-config";
import { generateRingtoneDataUrl } from "src/components/call/ringtone-generator";

export default function GlobalCallModal() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const {
    callState,
    isMinimized,
    callType,
    roomName,
    isGroup,
    participants,
    incomingCallData,
    localStream,
    remoteStreams,
    isAudioEnabled,
    isVideoEnabled,
    mediaError,
    connectionErrors,
    connectedPeers,
    callDuration,
    acceptCall,
    rejectCall,
    endCall,
    toggleMinimize,
    toggleAudio,
    toggleVideo,
  } = useGlobalCall();

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoPipRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());
  const remoteAudioRefs = useRef<Map<number, HTMLAudioElement>>(new Map());
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const isRingingRef = useRef(false);

  const setLocalVideoPipRef = useCallback(
    (el: HTMLVideoElement | null) => {
      localVideoPipRef.current = el;

      if (el && localStream && el.srcObject !== localStream) {
        el.srcObject = localStream;
      }
    },
    [localStream],
  );

  // Format call duration
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // Ringtone management
  useEffect(() => {
    if (callState === "incoming") {
      isRingingRef.current = true;
      playRingtone();
    } else {
      isRingingRef.current = false;
      stopRingtone();
    }

    return () => {
      stopRingtone();
    };
  }, [callState]);

  const playRingtone = async () => {
    try {
      if (RINGTONE_CONFIG.USE_AUDIO_FILE) {
        const audio = new Audio(RINGTONE_CONFIG.AUDIO_FILE_PATH);
        audio.loop = true;
        audio.volume = RINGTONE_CONFIG.GENERATED.volume;
        await audio.play().catch(() => {});
        audioElementRef.current = audio;
      } else {
        const audio = new Audio(generateRingtoneDataUrl());
        audio.loop = true;
        audio.volume = RINGTONE_CONFIG.GENERATED.volume;
        await audio.play().catch(() => {});
        audioElementRef.current = audio;
      }
    } catch {
      // Failed to play ringtone
    }
  };

  const stopRingtone = () => {
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.currentTime = 0;
      audioElementRef.current = null;
    }
  };

  // Attach video streams
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
    if (localVideoPipRef.current && localStream) {
      localVideoPipRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    remoteStreams.forEach((rs) => {
      const videoElement = remoteVideoRefs.current.get(rs.userId);
      if (videoElement && rs.stream) {
        videoElement.srcObject = rs.stream;
      }
    });
  }, [remoteStreams]);

  // Attach audio streams (crucial for audio calls)
  useEffect(() => {
    remoteStreams.forEach((rs) => {
      let audioElement = remoteAudioRefs.current.get(rs.userId);

      if (!audioElement) {
        audioElement = new Audio();
        audioElement.autoplay = true;
        audioElement.volume = 1.0;
        remoteAudioRefs.current.set(rs.userId, audioElement);
      }

      if (rs.stream) {
        audioElement.srcObject = rs.stream;
        audioElement.play().catch(() => {
          // Failed to play audio
        });
      }
    });

    const currentUserIds = new Set(remoteStreams.map((rs) => rs.userId));
    remoteAudioRefs.current.forEach((audio, userId) => {
      if (!currentUserIds.has(userId)) {
        audio.pause();
        audio.srcObject = null;
        remoteAudioRefs.current.delete(userId);
      }
    });

    const audioRefsSnapshot = remoteAudioRefs.current;
    return () => {
      audioRefsSnapshot.forEach((audio) => {
        audio.pause();
        audio.srcObject = null;
      });
      audioRefsSnapshot.clear();
    };
  }, [remoteStreams]);

  // Don't render if idle
  if (callState === "idle") return null;

  // Render minimized floating window
  if (isMinimized && callState === "active") {
    return (
      <Box
        onClick={toggleMinimize}
        sx={{
          position: "fixed",
          top: 80,
          right: 20,
          width: 280,
          bgcolor: theme.palette.background.paper,
          borderRadius: 2,
          boxShadow: theme.shadows[20],
          cursor: "pointer",
          zIndex: 9999,
          border: `2px solid ${theme.palette.primary.main}`,
          overflow: "hidden",
          transition: "all 0.3s ease",
          "&:hover": {
            transform: "scale(1.02)",
            boxShadow: theme.shadows[24],
          },
        }}
      >
        <Box
          sx={{
            p: 2,
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.1)} 0%, ${alpha(theme.palette.primary.main, 0.05)} 100%)`,
          }}
        >
          <Box
            sx={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              bgcolor: theme.palette.primary.main,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              animation: "pulse 2s infinite",
              "@keyframes pulse": {
                "0%, 100%": { opacity: 1 },
                "50%": { opacity: 0.7 },
              },
            }}
          >
            {callType === "video" ? (
              <VideoIcon size={24} color="white" />
            ) : (
              <Phone size={24} color="white" />
            )}
          </Box>

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" fontWeight={600} noWrap>
              {roomName || participants[0]?.name || "Appel en cours"}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {formatDuration(callDuration)}
            </Typography>
          </Box>

          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              endCall();
            }}
            sx={{
              bgcolor: theme.palette.error.main,
              color: "white",
              "&:hover": {
                bgcolor: theme.palette.error.dark,
              },
            }}
          >
            <PhoneOff size={18} />
          </IconButton>
        </Box>

        {isAudioEnabled && localStream && (
          <Box sx={{ px: 2, pb: 2 }}>
            <AudioVisualizer stream={localStream} size={40} />
          </Box>
        )}
      </Box>
    );
  }

  // Render incoming call modal
  if (callState === "incoming" && incomingCallData) {
    return (
      <Box
        sx={{
          position: "fixed",
          inset: 0,
          zIndex: 10000,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          bgcolor: "rgba(0, 0, 0, 0.7)",
        }}
      >
        <Box
          sx={{
            bgcolor: theme.palette.background.paper,
            borderRadius: 4,
            p: 4,
            maxWidth: 400,
            width: "90%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 3,
            boxShadow: theme.shadows[24],
          }}
        >
          <Box
            sx={{
              position: "relative",
              animation: "pulse 2s infinite",
              "@keyframes pulse": {
                "0%, 100%": { transform: "scale(1)", opacity: 1 },
                "50%": { transform: "scale(1.05)", opacity: 0.8 },
              },
            }}
          >
            <Avatar
              src={incomingCallData.callerAvatar}
              sx={{
                width: 100,
                height: 100,
                fontSize: 40,
                bgcolor: theme.palette.primary.main,
                border: `4px solid ${alpha(theme.palette.primary.main, 0.2)}`,
              }}
            >
              {incomingCallData.callerName.charAt(0).toUpperCase()}
            </Avatar>
            <Box
              sx={{
                position: "absolute",
                bottom: 0,
                right: 0,
                bgcolor:
                  incomingCallData.callType === "video"
                    ? theme.palette.info.main
                    : theme.palette.success.main,
                borderRadius: "50%",
                p: 1,
                border: `3px solid ${theme.palette.background.paper}`,
              }}
            >
              {incomingCallData.callType === "video" ? (
                <VideoIcon size={20} color="white" />
              ) : (
                <Phone size={20} color="white" />
              )}
            </Box>
          </Box>

          <Box sx={{ textAlign: "center" }}>
            <Typography variant="h5" fontWeight={600} gutterBottom>
              {incomingCallData.callerName}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {incomingCallData.callType === "video"
                ? "Appel vidéo entrant..."
                : "Appel vocal entrant..."}
            </Typography>
          </Box>

          <Box sx={{ display: "flex", gap: 4, mt: 2 }}>
            <Box sx={{ textAlign: "center" }}>
              <IconButton
                onClick={rejectCall}
                sx={{
                  width: 64,
                  height: 64,
                  bgcolor: theme.palette.error.main,
                  color: "white",
                  "&:hover": {
                    bgcolor: theme.palette.error.dark,
                    transform: "scale(1.05)",
                  },
                  transition: "all 0.2s",
                  mb: 1,
                }}
              >
                <PhoneOff size={28} />
              </IconButton>
              <Typography
                variant="caption"
                display="block"
                color="text.secondary"
              >
                Refuser
              </Typography>
            </Box>

            <Box sx={{ textAlign: "center" }}>
              <IconButton
                onClick={acceptCall}
                sx={{
                  width: 64,
                  height: 64,
                  bgcolor: theme.palette.success.main,
                  color: "white",
                  animation: "bounce 2s infinite",
                  "&:hover": {
                    bgcolor: theme.palette.success.dark,
                    transform: "scale(1.05)",
                  },
                  transition: "all 0.2s",
                  "@keyframes bounce": {
                    "0%, 100%": { transform: "translateY(0)" },
                    "50%": { transform: "translateY(-8px)" },
                  },
                  mb: 1,
                }}
              >
                <Phone size={28} />
              </IconButton>
              <Typography
                variant="caption"
                display="block"
                color="text.secondary"
              >
                Accepter
              </Typography>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  // Render active call modal (expanded)
  if (callState === "active" && !isMinimized) {
    const displayName = roomName || participants[0]?.name || "Appel en cours";

    return (
      <Box
        sx={{
          position: "fixed",
          inset: 0,
          zIndex: 10000,
          bgcolor: "#000",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <Box
          sx={{
            p: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0) 100%)",
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            {isGroup && <Users size={20} color="white" />}
            <Box>
              <Typography variant="subtitle1" color="white" fontWeight={600}>
                {displayName}
              </Typography>
              <Typography variant="caption" color="rgba(255,255,255,0.7)">
                {formatDuration(callDuration)}
              </Typography>
            </Box>
          </Box>

          <Tooltip title="Minimiser">
            <IconButton onClick={toggleMinimize} sx={{ color: "white" }}>
              <Minimize2 size={20} />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Video Grid - Smart Layout like Messenger/Google Meet */}
        <Box
          sx={{
            flex: 1,
            position: "relative",
            overflow: "hidden",
            p: isMobile ? 1 : 2,
          }}
        >
          {/* Calculate optimal grid layout */}
          {(() => {
            const remoteCount = remoteStreams.length;

            // For video calls: Show remotes in grid, local as PIP overlay
            // For audio calls: Show all participants in grid
            const shouldShowLocalInGrid =
              callType === "audio" || remoteCount === 0;
            const totalInGrid = shouldShowLocalInGrid
              ? remoteCount + 1
              : remoteCount;

            // Determine grid layout based on participant count
            let gridCols: number;
            let gridRows: number;

            if (totalInGrid === 1) {
              gridCols = 1;
              gridRows = 1;
            } else if (totalInGrid === 2) {
              gridCols = isMobile ? 1 : 2;
              gridRows = isMobile ? 2 : 1;
            } else if (totalInGrid <= 4) {
              gridCols = 2;
              gridRows = 2;
            } else if (totalInGrid <= 6) {
              gridCols = 3;
              gridRows = 2;
            } else if (totalInGrid <= 9) {
              gridCols = 3;
              gridRows = 3;
            } else {
              gridCols = 4;
              gridRows = Math.ceil(totalInGrid / 4);
            }

            return (
              <>
                {/* Main Grid */}
                <Box
                  sx={{
                    height: "100%",
                    display: "grid",
                    gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
                    gridTemplateRows: `repeat(${gridRows}, 1fr)`,
                    gap: isMobile ? 1 : 1.5,
                    overflow: "auto",
                    alignItems: "stretch",
                    "&::-webkit-scrollbar": {
                      width: 8,
                    },
                    "&::-webkit-scrollbar-thumb": {
                      backgroundColor: alpha("#fff", 0.3),
                      borderRadius: "4px",
                    },
                  }}
                >
                  {/* Remote streams */}
                  {remoteStreams.length > 0 ? (
                    remoteStreams.map((rs) => {
                      const participant = participants.find(
                        (p) => p.id === rs.userId,
                      );
                      return (
                        <Box
                          key={rs.userId}
                          sx={{
                            position: "relative",
                            bgcolor: "#1a1a1a",
                            borderRadius: isMobile ? 2 : 3,
                            overflow: "hidden",
                            border: "2px solid rgba(255,255,255,0.1)",
                            minHeight: 0,
                            width: "100%",
                            height: "100%",
                            "& > video": {
                              width: "100%",
                              height: "100%",
                              objectFit: "cover",
                              display: "block",
                            },
                          }}
                        >
                          {callType === "video" ? (
                            <video
                              ref={(el) => {
                                if (el)
                                  remoteVideoRefs.current.set(rs.userId, el);
                              }}
                              autoPlay
                              playsInline
                            />
                          ) : (
                            <Box
                              sx={{
                                width: "100%",
                                height: "100%",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                flexDirection: "column",
                                gap: totalInGrid <= 4 ? 2 : 1,
                              }}
                            >
                              <Avatar
                                src={participant?.avatar}
                                sx={{
                                  width:
                                    totalInGrid <= 2
                                      ? 100
                                      : totalInGrid <= 4
                                        ? 70
                                        : 50,
                                  height:
                                    totalInGrid <= 2
                                      ? 100
                                      : totalInGrid <= 4
                                        ? 70
                                        : 50,
                                  fontSize:
                                    totalInGrid <= 2
                                      ? 40
                                      : totalInGrid <= 4
                                        ? 28
                                        : 20,
                                  bgcolor: theme.palette.primary.main,
                                }}
                              >
                                {participant?.name?.charAt(0).toUpperCase()}
                              </Avatar>
                              <Typography
                                variant={
                                  totalInGrid <= 2
                                    ? "h6"
                                    : totalInGrid <= 4
                                      ? "body1"
                                      : "body2"
                                }
                                color="white"
                                sx={{ fontWeight: 600, textAlign: "center" }}
                              >
                                {participant?.name}
                              </Typography>
                              {totalInGrid <= 4 && (
                                <AudioVisualizer
                                  stream={rs.stream}
                                  size={totalInGrid <= 2 ? 60 : 50}
                                />
                              )}
                            </Box>
                          )}

                          {/* Name overlay */}
                          <Box
                            sx={{
                              position: "absolute",
                              bottom: 8,
                              left: 8,
                              bgcolor: alpha("#000", 0.7),
                              backdropFilter: "blur(8px)",
                              color: "white",
                              px: 1.5,
                              py: 0.5,
                              borderRadius: 1.5,
                              fontSize: isMobile ? 11 : 12,
                              fontWeight: 600,
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            {rs.stream?.getAudioTracks()[0] &&
                              !rs.stream.getAudioTracks()[0].enabled && (
                                <MicOff size={12} color="white" />
                              )}
                            {participant?.name || `Utilisateur ${rs.userId}`}
                          </Box>
                        </Box>
                      );
                    })
                  ) : (
                    // Waiting screen when no remote participants yet
                    <Box
                      sx={{
                        gridColumn: `1 / -1`,
                        gridRow: `1 / -1`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexDirection: "column",
                        gap: 2,
                        color: "white",
                      }}
                    >
                      <Avatar
                        sx={{
                          width: 100,
                          height: 100,
                          fontSize: 40,
                          bgcolor: theme.palette.primary.main,
                        }}
                      >
                        {participants[0]?.name?.charAt(0).toUpperCase() || "?"}
                      </Avatar>
                      <Typography variant="h6">
                        {participants[0]?.name || "En attente..."}
                      </Typography>
                      {!(
                        participants[0] &&
                        connectedPeers.has(participants[0].id)
                      ) && (
                        <Typography
                          variant="body2"
                          color="rgba(255,255,255,0.6)"
                        >
                          Connexion en cours...
                        </Typography>
                      )}
                    </Box>
                  )}

                  {/* Local stream in grid (only for audio calls or when alone) */}
                  {shouldShowLocalInGrid && callType === "video" && (
                    <Box
                      sx={{
                        position: "relative",
                        bgcolor: "#1a1a1a",
                        borderRadius: isMobile ? 2 : 3,
                        overflow: "hidden",
                        border: `2px solid ${theme.palette.primary.main}`,
                        minHeight: 0,
                        width: "100%",
                        height: "100%",
                        "& > video": {
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                          transform: "scaleX(-1)",
                          display: "block",
                        },
                      }}
                    >
                      <video ref={localVideoRef} autoPlay playsInline muted />
                      <Box
                        sx={{
                          position: "absolute",
                          bottom: 8,
                          left: 8,
                          bgcolor: alpha("#000", 0.7),
                          backdropFilter: "blur(8px)",
                          color: "white",
                          px: 1.5,
                          py: 0.5,
                          borderRadius: 1.5,
                          fontSize: isMobile ? 11 : 12,
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          gap: 0.5,
                        }}
                      >
                        {!isAudioEnabled && <MicOff size={12} color="white" />}
                        Vous
                      </Box>
                      {!isVideoEnabled && (
                        <Box
                          sx={{
                            position: "absolute",
                            inset: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexDirection: "column",
                            gap: 2,
                            bgcolor: alpha("#000", 0.9),
                          }}
                        >
                          <Avatar
                            sx={{
                              width:
                                totalInGrid <= 2
                                  ? 80
                                  : totalInGrid <= 4
                                    ? 60
                                    : 48,
                              height:
                                totalInGrid <= 2
                                  ? 80
                                  : totalInGrid <= 4
                                    ? 60
                                    : 48,
                              fontSize:
                                totalInGrid <= 2
                                  ? 32
                                  : totalInGrid <= 4
                                    ? 24
                                    : 20,
                              bgcolor: theme.palette.primary.main,
                            }}
                          >
                            V
                          </Avatar>
                          {isAudioEnabled && totalInGrid <= 4 && (
                            <AudioVisualizer stream={localStream} size={50} />
                          )}
                        </Box>
                      )}
                    </Box>
                  )}
                </Box>

                {/* Picture-in-Picture: Local video overlay (for video calls with remotes) */}
                {callType === "video" &&
                  remoteStreams.length > 0 &&
                  !shouldShowLocalInGrid && (
                    <Box
                      sx={{
                        position: "absolute",
                        top: isMobile ? 16 : 24,
                        right: isMobile ? 16 : 24,
                        width: isMobile ? 120 : 200,
                        height: isMobile ? 90 : 150,
                        borderRadius: 2,
                        overflow: "hidden",
                        border: `3px solid ${theme.palette.primary.main}`,
                        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                        bgcolor: "#1a1a1a",
                        zIndex: 10,
                        transition: "all 0.3s ease",
                        "&:hover": {
                          transform: "scale(1.05)",
                          boxShadow: "0 12px 40px rgba(0,0,0,0.7)",
                        },
                        "& > video": {
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                          transform: "scaleX(-1)",
                          display: "block",
                        },
                      }}
                    >
                      <video
                        ref={setLocalVideoPipRef}
                        autoPlay
                        playsInline
                        muted
                      />
                      <Box
                        sx={{
                          position: "absolute",
                          bottom: 6,
                          left: 6,
                          bgcolor: alpha("#000", 0.7),
                          backdropFilter: "blur(8px)",
                          color: "white",
                          px: 1,
                          py: 0.25,
                          borderRadius: 1,
                          fontSize: 10,
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          gap: 0.5,
                        }}
                      >
                        {!isAudioEnabled && <MicOff size={10} color="white" />}
                        Vous
                      </Box>
                      {!isVideoEnabled && (
                        <Box
                          sx={{
                            position: "absolute",
                            inset: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            bgcolor: alpha("#000", 0.9),
                          }}
                        >
                          <Avatar
                            sx={{
                              width: isMobile ? 40 : 60,
                              height: isMobile ? 40 : 60,
                              fontSize: isMobile ? 16 : 24,
                              bgcolor: theme.palette.primary.main,
                            }}
                          >
                            V
                          </Avatar>
                        </Box>
                      )}
                    </Box>
                  )}
              </>
            );
          })()}
        </Box>

        {/* Error alerts */}
        {(mediaError || connectionErrors.size > 0) && (
          <Box sx={{ px: 2, pb: 2 }}>
            {mediaError && (
              <Alert severity="error" sx={{ mb: 1 }}>
                {mediaError}
              </Alert>
            )}
            {Array.from(connectionErrors.entries()).map(([userId, error]) => {
              const participant = participants.find((p) => p.id === userId);
              return (
                <Alert key={userId} severity="warning" sx={{ mb: 1 }}>
                  Problème de connexion avec{" "}
                  {participant?.name || `Utilisateur ${userId}`}: {error}
                </Alert>
              );
            })}
          </Box>
        )}

        {/* Controls */}
        <Box
          sx={{
            p: 3,
            background:
              "linear-gradient(0deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0) 100%)",
            display: "flex",
            justifyContent: "center",
            gap: 2,
          }}
        >
          <Tooltip
            title={isAudioEnabled ? "Couper le micro" : "Activer le micro"}
          >
            <IconButton
              onClick={toggleAudio}
              sx={{
                width: 56,
                height: 56,
                bgcolor: isAudioEnabled
                  ? alpha("#fff", 0.2)
                  : theme.palette.error.main,
                color: "white",
                "&:hover": {
                  bgcolor: isAudioEnabled
                    ? alpha("#fff", 0.3)
                    : theme.palette.error.dark,
                },
              }}
            >
              {isAudioEnabled ? <Mic size={24} /> : <MicOff size={24} />}
            </IconButton>
          </Tooltip>

          {callType === "video" && (
            <Tooltip
              title={isVideoEnabled ? "Couper la caméra" : "Activer la caméra"}
            >
              <IconButton
                onClick={toggleVideo}
                sx={{
                  width: 56,
                  height: 56,
                  bgcolor: isVideoEnabled
                    ? alpha("#fff", 0.2)
                    : theme.palette.error.main,
                  color: "white",
                  "&:hover": {
                    bgcolor: isVideoEnabled
                      ? alpha("#fff", 0.3)
                      : theme.palette.error.dark,
                  },
                }}
              >
                {isVideoEnabled ? (
                  <VideoIcon size={24} />
                ) : (
                  <VideoOff size={24} />
                )}
              </IconButton>
            </Tooltip>
          )}

          <Tooltip title="Raccrocher">
            <IconButton
              onClick={endCall}
              sx={{
                width: 56,
                height: 56,
                bgcolor: theme.palette.error.main,
                color: "white",
                "&:hover": {
                  bgcolor: theme.palette.error.dark,
                  transform: "scale(1.05)",
                },
              }}
            >
              <PhoneOff size={24} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
    );
  }

  return null;
}
