import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { getSocket } from "src/lib/socket";
import {
  useMediaStream,
  type CallType,
} from "src/sections/messages/messages-view/hooks/useMediaStream";
import { useWebRTC } from "src/sections/messages/messages-view/hooks/useWebRTC";

type CallState = "idle" | "incoming" | "active";

export type CallParticipant = {
  id: number;
  name: string;
  avatar?: string;
};

type IncomingCallData = {
  callId: number;
  callerId: number;
  callerName: string;
  callerAvatar?: string;
  roomId: number;
  callType: CallType;
  isGroup?: boolean;
};

type GlobalCallContextValue = {
  // State
  callState: CallState;
  isMinimized: boolean;
  callType: CallType | null;
  roomId: number | null;
  roomName: string | null;
  isGroup: boolean;
  participants: CallParticipant[];
  incomingCallData: IncomingCallData | null;

  // Media state
  localStream: MediaStream | null;
  remoteStreams: Array<{ userId: number; stream: MediaStream }>;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  mediaError: string | null;
  connectionErrors: Map<number, string>;
  callDuration: number;

  // Actions
  initiateCall: (
    roomId: number,
    type: CallType,
    participants: CallParticipant[],
    roomName?: string,
    isGroup?: boolean,
  ) => Promise<void>;
  joinCall: (
    roomId: number,
    callId: number,
    isGroup?: boolean,
  ) => Promise<void>;
  acceptCall: () => Promise<void>;
  rejectCall: () => void;
  endCall: () => void;
  toggleMinimize: () => void;
  toggleAudio: () => void;
  toggleVideo: () => void;
};

const GlobalCallContext = createContext<GlobalCallContextValue | undefined>(
  undefined,
);

export function GlobalCallProvider({ children }: { children: ReactNode }) {
  // Call state
  const [callState, setCallState] = useState<CallState>("idle");
  const [isMinimized, setIsMinimized] = useState(false);
  const [callType, setCallType] = useState<CallType | null>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [isGroup, setIsGroup] = useState(false);
  const [participants, setParticipants] = useState<CallParticipant[]>([]);
  const [incomingCallData, setIncomingCallData] =
    useState<IncomingCallData | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const callStartTimeRef = useRef<number>(0);
  const currentUserIdRef = useRef<number>(0);
  const callIdRef = useRef<number | null>(null);

  // Get current user ID from auth state
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        currentUserIdRef.current = payload.sub || 0;
      } catch {
        // Token parse error
      }
    }
  }, []);

  // WebRTC hooks
  const {
    stream: localStream,
    error: mediaError,
    startStream,
    stopStream,
    toggleAudio: toggleAudioStream,
    toggleVideo: toggleVideoStream,
    isAudioEnabled,
    isVideoEnabled,
  } = useMediaStream(callType);

  const {
    remoteStreams,
    connectionErrors,
    makeOffer,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    closePeerConnection,
    closeAllConnections,
  } = useWebRTC(roomId || 0, localStream);

  // Reset all call state
  const resetCallState = useCallback(() => {
    setCallState("idle");
    setIsMinimized(false);
    setCallType(null);
    setRoomId(null);
    setRoomName(null);
    setIsGroup(false);
    setParticipants([]);
    setIncomingCallData(null);
    callIdRef.current = null;
    stopStream();
    closeAllConnections();
  }, [stopStream, closeAllConnections]);

  // Call duration timer
  useEffect(() => {
    if (callState !== "active") {
      setCallDuration(0);
      return undefined;
    }

    const interval = setInterval(() => {
      const elapsed = Math.floor(
        (Date.now() - callStartTimeRef.current) / 1000,
      );
      setCallDuration(elapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [callState]);

  // Socket event listeners
  useEffect(() => {
    const socketInstance = getSocket();

    // Incoming call
    socketInstance.on(
      "call:incoming",
      (data: {
        callId: number;
        callerId: number;
        roomId: number;
        callType: CallType;
        initiatorName: string;
        isGroup?: boolean;
      }) => {
        setIncomingCallData({
          callId: data.callId,
          callerId: data.callerId,
          callerName: data.initiatorName,
          roomId: data.roomId,
          callType: data.callType,
          isGroup: data.isGroup,
        });
        setCallState("incoming");
      },
    );

    // WebRTC signaling
    socketInstance.on(
      "call:offer",
      async (data: {
        callerId: number;
        roomId: number;
        offer: RTCSessionDescriptionInit;
      }) => {
        await handleOffer(data.callerId, data.offer);
      },
    );

    socketInstance.on(
      "call:answer",
      async (data: {
        callerId: number;
        roomId: number;
        answer: RTCSessionDescriptionInit;
      }) => {
        await handleAnswer(data.callerId, data.answer);
      },
    );

    socketInstance.on(
      "call:ice-candidate",
      async (data: {
        callerId: number;
        roomId: number;
        candidate: RTCIceCandidateInit;
      }) => {
        await handleIceCandidate(data.callerId, data.candidate);
      },
    );

    socketInstance.on(
      "call:accepted",
      (data: { acceptedBy: number; roomId: number; userName?: string }) => {
        if (callState !== "active") {
          setCallState("active");
          callStartTimeRef.current = Date.now();
        }

        setParticipants((prev) => {
          if (prev.some((p) => p.id === data.acceptedBy)) {
            return prev;
          }
          return [
            ...prev,
            {
              id: data.acceptedBy,
              name: data.userName || `User ${data.acceptedBy}`,
            },
          ];
        });

        makeOffer(data.acceptedBy);
      },
    );

    socketInstance.on(
      "call:user-joined",
      (data: { userId: number; roomId: number; userName?: string }) => {
        if (data.userId !== currentUserIdRef.current) {
          // Ensure localStream is ready before making offer
          if (!localStream) {
            // Wait for stream to be ready
            const checkInterval = setInterval(() => {
              if (localStream) {
                clearInterval(checkInterval);
                makeOffer(data.userId);
              }
            }, 100);

            // Timeout after 3 seconds
            setTimeout(() => clearInterval(checkInterval), 3000);
          } else {
            // Make offer immediately
            makeOffer(data.userId);
          }

          setParticipants((prev) => {
            if (prev.some((p) => p.id === data.userId)) {
              return prev;
            }
            return [
              ...prev,
              {
                id: data.userId,
                name: data.userName || `User ${data.userId}`,
              },
            ];
          });
        }
      },
    );

    // New handler: Notify newly joined user of all existing participants
    socketInstance.on(
      "call:existing-participants",
      (data: { participants: Array<{ userId: number; userName: string }> }) => {
        // Wait a bit to ensure localStream is fully ready
        setTimeout(() => {
          data.participants.forEach((participant) => {
            if (participant.userId !== currentUserIdRef.current) {
              makeOffer(participant.userId);

              setParticipants((prev) => {
                if (prev.some((p) => p.id === participant.userId)) {
                  return prev;
                }
                return [
                  ...prev,
                  {
                    id: participant.userId,
                    name: participant.userName,
                  },
                ];
              });
            }
          });
        }, 500);
      },
    );

    socketInstance.on(
      "call:rejected",
      (data: { rejectedBy: number; roomId: number; callEnded?: boolean }) => {
        // Only reset if the call actually ended (1:1 calls only)
        // For group calls, rejection doesn't end the call
        if (data.callEnded) {
          resetCallState();
        }
        // For group calls, ignore rejections - call continues
      },
    );

    socketInstance.on(
      "call:ended",
      (data: { endedBy: number; roomId: number; callEnded?: boolean }) => {
        // Only reset if call actually ended (last person left)
        // For group calls, individual leaves don't end the call
        if (data.callEnded !== false) {
          resetCallState();
        }
      },
    );

    // Caller side: the callee never answered within the ring timeout.
    // Without this, the caller's own screen stays stuck on "En attente..."
    // forever since it never receives call:ended in that case.
    socketInstance.on(
      "call:missed",
      (_data: { roomId: number; callId: number }) => {
        resetCallState();
      },
    );

    socketInstance.on(
      "call:user-left",
      (data: { userId: number; roomId: number }) => {
        setParticipants((prev) => prev.filter((p) => p.id !== data.userId));
        closePeerConnection(data.userId);
      },
    );

    return () => {
      socketInstance.off("call:incoming");
      socketInstance.off("call:offer");
      socketInstance.off("call:answer");
      socketInstance.off("call:ice-candidate");
      socketInstance.off("call:accepted");
      socketInstance.off("call:user-joined");
      socketInstance.off("call:existing-participants");
      socketInstance.off("call:user-left");
      socketInstance.off("call:rejected");
      socketInstance.off("call:ended");
      socketInstance.off("call:missed");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    makeOffer,
    closePeerConnection,
    callState,
    resetCallState,
  ]);

  // Initiate a call
  const initiateCall = useCallback(
    async (
      rid: number,
      type: CallType,
      parts: CallParticipant[],
      rName?: string,
      isGrp?: boolean,
    ) => {
      if (callState !== "idle") {
        return;
      }

      setCallType(type);
      setRoomId(rid);
      setRoomName(rName || null);
      setIsGroup(isGrp || false);
      setParticipants(parts);
      setCallState("active");
      callStartTimeRef.current = Date.now();

      try {
        await startStream(type);
      } catch (error) {
        console.error(
          "[GlobalCallContext] Failed to start media stream:",
          error,
        );
        resetCallState();
        alert(
          "Impossible d'accéder au microphone/caméra. Veuillez autoriser l'accès dans les paramètres du navigateur.",
        );
        return;
      }

      const socketInstance = getSocket();
      const participantIds = parts.map((p) => p.id);

      socketInstance.emit(
        "call:initiate",
        {
          roomId: rid,
          callType: type,
          participants: [currentUserIdRef.current, ...participantIds],
          isGroup: isGrp,
        },
        (response: any) => {
          if (response?.success && response?.callId) {
            callIdRef.current = response.callId;
          } else {
            resetCallState();
            alert(
              "Erreur lors de l'initiation de l'appel. Veuillez réessayer.",
            );
          }
        },
      );
    },
    [startStream, resetCallState, callState],
  );

  // Join an ongoing call
  const joinCall = useCallback(
    async (rid: number, callId: number, isGrp: boolean = true) => {
      if (callState !== "idle") {
        return;
      }

      console.log("[GlobalCallContext] Joining call:", callId);

      // CRITICAL FIX: Get call info first to know the call type
      const socketInstance = getSocket();

      // First, get the call type
      socketInstance.emit(
        "call:join",
        {
          roomId: rid,
          callId,
        },
        async (response: any) => {
          if (!response?.success) {
            console.error("[GlobalCallContext] Failed to join call:", response);
            alert("Impossible de rejoindre l'appel. Il est peut-être terminé.");
            return;
          }

          const type: CallType = response.callType || "video";

          setCallType(type);
          setRoomId(rid);
          setIsGroup(isGrp);
          callIdRef.current = callId;

          // Start media stream FIRST, before announcing we're ready
          try {
            await startStream(type);

            // Only set state to active AFTER media is ready
            setCallState("active");
            callStartTimeRef.current = Date.now();

            // Now announce we're ready
            socketInstance.emit("call:ready", {
              roomId: rid,
              callId,
            });
          } catch (error) {
            resetCallState();
            alert("Impossible d'accéder au microphone/caméra.");
            return;
          }
        },
      );
    },
    [startStream, resetCallState, callState],
  );

  // Accept incoming call
  const acceptCall = useCallback(async () => {
    if (!incomingCallData) {
      return;
    }

    const incomingType = incomingCallData.callType;
    setCallType(incomingType);
    setRoomId(incomingCallData.roomId);
    setIsGroup(incomingCallData.isGroup || false);
    setCallState("active");
    callStartTimeRef.current = Date.now();

    setParticipants([
      {
        id: incomingCallData.callerId,
        name: incomingCallData.callerName,
        avatar: incomingCallData.callerAvatar,
      },
    ]);

    try {
      await startStream(incomingType);
    } catch {
      resetCallState();
      alert("Impossible d'accéder au microphone/caméra.");
      return;
    }

    // Save the callId for later use
    callIdRef.current = incomingCallData.callId;

    const socketInstance = getSocket();
    socketInstance.emit("call:accept", {
      roomId: incomingCallData.roomId,
      callerId: incomingCallData.callerId,
      callId: incomingCallData.callId,
    });

    setIncomingCallData(null);
  }, [incomingCallData, startStream, resetCallState]);

  // Reject incoming call
  const rejectCall = useCallback(() => {
    if (!incomingCallData) return;

    const socketInstance = getSocket();
    socketInstance.emit("call:reject", {
      roomId: incomingCallData.roomId,
      callerId: incomingCallData.callerId,
      callId: incomingCallData.callId,
      isGroup: incomingCallData.isGroup,
    });

    // For group calls, just dismiss the notification (don't reset if we're already in the call)
    // For 1:1 calls, reset the state
    if (!incomingCallData.isGroup) {
      resetCallState();
    } else {
      // Just dismiss the incoming notification
      setIncomingCallData(null);
      if (callState === "incoming") {
        setCallState("idle");
      }
    }
  }, [incomingCallData, resetCallState, callState]);

  // End active call
  const endCall = useCallback(() => {
    if (!roomId) return;

    const duration = Math.floor((Date.now() - callStartTimeRef.current) / 1000);
    const participantIds = participants.map((p) => p.id);

    const socketInstance = getSocket();
    socketInstance.emit("call:end", {
      roomId,
      participants: [currentUserIdRef.current, ...participantIds],
      duration,
      callId: callIdRef.current,
    });

    resetCallState();
  }, [roomId, participants, resetCallState]);

  // Toggle minimize
  const toggleMinimize = useCallback(() => {
    setIsMinimized((prev) => !prev);
  }, []);

  // Toggle audio
  const toggleAudio = useCallback(() => {
    if (!localStream) {
      return;
    }

    toggleAudioStream();
  }, [toggleAudioStream, localStream]);

  // Toggle video
  const toggleVideo = useCallback(() => {
    toggleVideoStream();
  }, [toggleVideoStream]);

  const value = useMemo<GlobalCallContextValue>(
    () => ({
      callState,
      isMinimized,
      callType,
      roomId,
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
      callDuration,
      initiateCall,
      joinCall,
      acceptCall,
      rejectCall,
      endCall,
      toggleMinimize,
      toggleAudio,
      toggleVideo,
    }),
    [
      callState,
      isMinimized,
      callType,
      roomId,
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
      callDuration,
      initiateCall,
      joinCall,
      acceptCall,
      rejectCall,
      endCall,
      toggleMinimize,
      toggleAudio,
      toggleVideo,
    ],
  );

  return (
    <GlobalCallContext.Provider value={value}>
      {children}
    </GlobalCallContext.Provider>
  );
}

export function useGlobalCall() {
  const context = useContext(GlobalCallContext);
  if (!context) {
    throw new Error("useGlobalCall must be used within GlobalCallProvider");
  }
  return context;
}
