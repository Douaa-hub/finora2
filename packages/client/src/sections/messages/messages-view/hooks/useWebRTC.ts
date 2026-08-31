import { useState, useCallback, useEffect, useRef } from "react";
import { getSocket } from "src/lib/socket";

export type RemoteStream = {
  userId: number;
  stream: MediaStream;
};

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

// TEMPORARY DEBUG LOGGING — remove once the video-call regression is confirmed fixed.
function webrtcStreamLabel(stream: MediaStream | null): "VIDEO" | "AUDIO" | "NONE" {
  if (!stream) return "NONE";
  return stream.getVideoTracks().length > 0 ? "VIDEO" : "AUDIO";
}

function webrtcTrackSummary(stream: MediaStream | null | undefined) {
  if (!stream) return [];
  return stream.getTracks().map((t) => ({
    kind: t.kind,
    enabled: t.enabled,
    muted: t.muted,
    readyState: t.readyState,
  }));
}

export function useWebRTC(roomId: number, localStream: MediaStream | null) {
  const [peers, setPeers] = useState<Map<number, RTCPeerConnection>>(new Map());
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);
  const [connectionErrors, setConnectionErrors] = useState<Map<number, string>>(
    new Map(),
  );
  // Purely observational mirror of pc.connectionState === "connected" per
  // peer — read-only reflection for the UI, never consulted by any
  // signaling/negotiation logic above.
  const [connectedPeers, setConnectedPeers] = useState<Set<number>>(new Set());
  const socket = getSocket();
  const peersRef = useRef<Map<number, RTCPeerConnection>>(new Map());
  const pendingIceCandidatesRef = useRef<Map<number, RTCIceCandidateInit[]>>(
    new Map(),
  );
  // Live-updated mirror of localStream — read this instead of the closed-
  // over `localStream` parameter in callbacks that may retry/wait, since a
  // closure variable can never change within the same callback instance no
  // matter how long you wait (video calls, whose getUserMedia resolves much
  // slower than audio, were hitting exactly this stale-closure race).
  const localStreamRef = useRef<MediaStream | null>(localStream);

  // TEMPORARY DEBUG LOGGING — remove once the video-call regression is confirmed fixed.
  const logWebRTC = useCallback(
    (userId: number, ...args: unknown[]) => {
      // eslint-disable-next-line no-console
      console.log(
        `[WEBRTC][${userId}][${webrtcStreamLabel(localStreamRef.current)}]`,
        ...args,
      );
    },
    [],
  );

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  const createPeerConnection = useCallback(
    (userId: number): RTCPeerConnection => {
      const existingPeer = peersRef.current.get(userId);
      if (existingPeer) {
        return existingPeer;
      }

      const pc = new RTCPeerConnection(ICE_SERVERS);

      const currentStream = localStreamRef.current;
      logWebRTC(
        userId,
        "createPeerConnection: localStream tracks =",
        webrtcTrackSummary(currentStream),
      );
      if (currentStream) {
        const tracks = currentStream.getTracks();

        tracks.forEach((track) => {
          // Ensure track is enabled
          if (!track.enabled) {
            track.enabled = true;
          }

          pc.addTrack(track, currentStream);
          logWebRTC(userId, `addTrack() called for ${track.kind} track`, {
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState,
          });
        });
      }

      pc.ontrack = (event) => {
        logWebRTC(userId, "ontrack fired", {
          trackKind: event.track.kind,
          streamsCount: event.streams.length,
          remoteTracks: webrtcTrackSummary(event.streams[0]),
        });
        setRemoteStreams((prev) => {
          const existing = prev.find((rs) => rs.userId === userId);
          if (existing) {
            return prev.map((rs) =>
              rs.userId === userId ? { userId, stream: event.streams[0] } : rs,
            );
          }
          return [...prev, { userId, stream: event.streams[0] }];
        });
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          logWebRTC(userId, "ICE candidate SENT", {
            type: event.candidate.type,
            protocol: event.candidate.protocol,
          });
          socket.emit("call:ice-candidate", {
            roomId,
            targetUserId: userId,
            candidate: event.candidate,
          });
        } else {
          logWebRTC(userId, "ICE candidate gathering complete (null candidate)");
        }
      };

      pc.onsignalingstatechange = () => {
        logWebRTC(userId, "signalingState =", pc.signalingState);
      };

      pc.onicegatheringstatechange = () => {
        logWebRTC(userId, "iceGatheringState =", pc.iceGatheringState);
      };

      pc.oniceconnectionstatechange = () => {
        logWebRTC(userId, "iceConnectionState =", pc.iceConnectionState);
        // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change.
        console.log(
          `[CALL-TIMING] iceConnectionState = ${pc.iceConnectionState} t=${Date.now()} userId=${userId}`,
        );
        if (
          pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed"
        ) {
          setConnectionErrors((prev) => {
            const next = new Map(prev);
            next.delete(userId);
            return next;
          });
        }

        if (pc.iceConnectionState === "failed") {
          setConnectionErrors((prev) =>
            new Map(prev).set(userId, "Connection failed"),
          );
          try {
            pc.restartIce();
          } catch (error) {
            // ICE restart failed
          }
        }

        if (pc.iceConnectionState === "disconnected") {
          setConnectionErrors((prev) =>
            new Map(prev).set(userId, "Connection lost"),
          );
          setTimeout(() => {
            if (
              pc.iceConnectionState === "disconnected" ||
              pc.iceConnectionState === "failed"
            ) {
              closePeerConnection(userId);
            }
          }, 5000);
        }

        if (pc.iceConnectionState === "closed") {
          closePeerConnection(userId);
        }
      };

      pc.onconnectionstatechange = () => {
        logWebRTC(userId, "connectionState =", pc.connectionState);
        // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change.
        console.log(
          `[CALL-TIMING] connectionState = ${pc.connectionState} t=${Date.now()} userId=${userId}`,
        );
        if (pc.connectionState === "connected") {
          setConnectionErrors((prev) => {
            const next = new Map(prev);
            next.delete(userId);
            return next;
          });
          setConnectedPeers((prev) => {
            if (prev.has(userId)) return prev;
            return new Set(prev).add(userId);
          });
        } else {
          setConnectedPeers((prev) => {
            if (!prev.has(userId)) return prev;
            const next = new Set(prev);
            next.delete(userId);
            return next;
          });
        }

        if (pc.connectionState === "failed") {
          setConnectionErrors((prev) =>
            new Map(prev).set(userId, "Peer connection failed"),
          );
          closePeerConnection(userId);
        }
      };

      setPeers((prev) => new Map(prev).set(userId, pc));
      peersRef.current.set(userId, pc);

      return pc;
    },
    [localStream, roomId, socket, logWebRTC],
  );

  const makeOffer = useCallback(
    async (userId: number, retryCount: number = 0) => {
      if (!localStream) {
        return;
      }

      const pc = createPeerConnection(userId);

      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        logWebRTC(userId, "createOffer() done, signalingState =", pc.signalingState);
        await pc.setLocalDescription(offer);
        logWebRTC(userId, "setLocalDescription(offer) succeeded");

        logWebRTC(userId, "call:offer SENT");
        socket.emit("call:offer", {
          roomId,
          targetUserId: userId,
          offer,
        });

        setConnectionErrors((prev) => {
          const next = new Map(prev);
          next.delete(userId);
          return next;
        });
      } catch (error) {
        logWebRTC(userId, "makeOffer FAILED", error);
        setConnectionErrors((prev) =>
          new Map(prev).set(userId, "Failed to create connection offer"),
        );

        if (retryCount < 2) {
          setTimeout(
            () => {
              makeOffer(userId, retryCount + 1);
            },
            1000 * (retryCount + 1),
          );
        }
      }
    },
    [createPeerConnection, roomId, socket, localStream, logWebRTC],
  );

  const handleOffer = useCallback(
    async (userId: number, offer: RTCSessionDescriptionInit) => {
      logWebRTC(userId, "call:offer RECEIVED", {
        localStreamReady: !!localStreamRef.current,
      });

      // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change. Remove
      // once the accept-to-connected delay has been root-caused.
      console.log(
        `[CALL-TIMING] handleOffer begin t=${Date.now()} userId=${userId} localStreamReady=${!!localStreamRef.current}`,
      );

      if (!localStreamRef.current) {
        // The artificial 5s poll-wait that used to sit here was measured
        // ([CALL-TIMING] waiting for localStream end ... waited=5100ms) to
        // be the dominant source of accept-to-connected latency, so it has
        // been removed: proceed immediately and still answer/receive
        // remote media — a late-arriving local stream is picked up by the
        // late-track renegotiation effect below once it becomes ready.
        console.log("[CALL-TIMING] proceeding immediately without localStream");
        logWebRTC(
          userId,
          "proceeding without a local stream — will still answer and receive remote media",
        );
      }

      const pc = createPeerConnection(userId);

      try {
        // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change.
        console.log(
          `[CALL-TIMING] setRemoteDescription offer begin t=${Date.now()} userId=${userId}`,
        );
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(
          `[CALL-TIMING] setRemoteDescription offer end t=${Date.now()} userId=${userId}`,
        );
        logWebRTC(userId, "setRemoteDescription(offer) succeeded, signalingState =", pc.signalingState);

        // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change.
        console.log(
          `[CALL-TIMING] createAnswer begin t=${Date.now()} userId=${userId}`,
        );
        const answer = await pc.createAnswer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        console.log(
          `[CALL-TIMING] createAnswer end t=${Date.now()} userId=${userId}`,
        );
        logWebRTC(userId, "createAnswer() done");

        // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change.
        console.log(
          `[CALL-TIMING] setLocalDescription answer begin t=${Date.now()} userId=${userId}`,
        );
        await pc.setLocalDescription(answer);
        console.log(
          `[CALL-TIMING] setLocalDescription answer end t=${Date.now()} userId=${userId}`,
        );
        logWebRTC(userId, "setLocalDescription(answer) succeeded, signalingState =", pc.signalingState);

        logWebRTC(userId, "call:answer SENT");
        // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change.
        console.log(
          `[CALL-TIMING] call:answer SENT t=${Date.now()} userId=${userId}`,
        );
        socket.emit("call:answer", {
          roomId,
          targetUserId: userId,
          answer,
        });

        const pendingCandidates =
          pendingIceCandidatesRef.current.get(userId) || [];
        logWebRTC(userId, `applying ${pendingCandidates.length} pending ICE candidate(s)`);
        if (pendingCandidates.length > 0) {
          for (const candidate of pendingCandidates) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
              logWebRTC(userId, "FAILED to add pending ICE candidate", error);
            }
          }
          pendingIceCandidatesRef.current.delete(userId);
        }
      } catch (error) {
        logWebRTC(userId, "handleOffer FAILED", error);
      }
    },
    [createPeerConnection, roomId, socket, logWebRTC],
  );

  const handleAnswer = useCallback(
    async (userId: number, answer: RTCSessionDescriptionInit) => {
      const pc = peersRef.current.get(userId);
      logWebRTC(userId, "call:answer RECEIVED", { hasPeerConnection: !!pc });
      try {
        if (pc) {
          try {
            // An answer is only valid to apply while we're actually waiting
            // for one (have-local-offer). A duplicate/out-of-order
            // call:answer arriving after the connection already reached
            // "stable" is a real possibility (retries, duplicated signaling)
            // and applying it would throw InvalidStateError — checking the
            // precondition here is the correct WebRTC-level guard, not a
            // suppressed error.
            if (pc.signalingState !== "have-local-offer") {
              logWebRTC(
                userId,
                "IGNORING call:answer — signalingState is",
                pc.signalingState,
                "(not waiting for an answer)",
              );
              return;
            }

            // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change.
            console.log(
              `[CALL-TIMING] setRemoteDescription answer begin t=${Date.now()} userId=${userId}`,
            );
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            console.log(
              `[CALL-TIMING] setRemoteDescription answer end t=${Date.now()} userId=${userId}`,
            );
            logWebRTC(
              userId,
              "setRemoteDescription(answer) succeeded, signalingState =",
              pc.signalingState,
            );

            const pendingCandidates =
              pendingIceCandidatesRef.current.get(userId) || [];
            logWebRTC(
              userId,
              `applying ${pendingCandidates.length} pending ICE candidate(s) after answer`,
            );
            if (pendingCandidates.length > 0) {
              for (const candidate of pendingCandidates) {
                try {
                  await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch {
                  /* ignored */
                }
              }
            }
          } catch (err) {
            logWebRTC(userId, "setRemoteDescription(answer) FAILED", err);
          }
        }
      } catch (error) {
        logWebRTC(userId, "handleAnswer FAILED", error);
      }
    },
    [logWebRTC],
  );

  const handleIceCandidate = useCallback(
    async (userId: number, candidate: RTCIceCandidateInit) => {
      const pc = peersRef.current.get(userId);
      logWebRTC(userId, "ICE candidate RECEIVED", {
        hasPeerConnection: !!pc,
        hasRemoteDescription: !!pc?.remoteDescription,
      });

      if (pc) {
        if (pc.remoteDescription) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            logWebRTC(userId, "ICE candidate added immediately");
          } catch (err) {
            logWebRTC(userId, "FAILED to add ICE candidate immediately", err);
          }
        } else {
          logWebRTC(userId, "ICE candidate queued (no remoteDescription yet)");
          const pending = pendingIceCandidatesRef.current.get(userId) || [];
          pending.push(candidate);
          pendingIceCandidatesRef.current.set(userId, pending);
        }
      } else {
        logWebRTC(userId, "ICE candidate queued (no peer connection yet)");
        const pending = pendingIceCandidatesRef.current.get(userId) || [];
        pending.push(candidate);
        pendingIceCandidatesRef.current.set(userId, pending);
      }
    },
    [logWebRTC],
  );

  const closePeerConnection = useCallback((userId: number) => {
    const pc = peersRef.current.get(userId);

    if (pc) {
      pc.close();
      peersRef.current.delete(userId);
      setPeers((prev) => {
        const newMap = new Map(prev);
        newMap.delete(userId);
        return newMap;
      });
    }

    pendingIceCandidatesRef.current.delete(userId);
    setRemoteStreams((prev) => prev.filter((rs) => rs.userId !== userId));
    setConnectedPeers((prev) => {
      if (!prev.has(userId)) return prev;
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  }, []);

  const closeAllConnections = useCallback(() => {
    peersRef.current.forEach((pc) => {
      pc.close();
    });
    peersRef.current.clear();
    pendingIceCandidatesRef.current.clear();
    setPeers(new Map());
    setRemoteStreams([]);
    setConnectedPeers(new Set());
  }, []);

  useEffect(() => {
    // TEMPORARY DEBUG LOGGING — remove once the late-track renegotiation is confirmed working.
    // eslint-disable-next-line no-console
    console.log("[LATE-TRACK] localStream changed");
    // eslint-disable-next-line no-console
    console.log("[LATE-TRACK] hasStream =", !!localStream);
    // eslint-disable-next-line no-console
    console.log(
      "[LATE-TRACK] audioTracks =",
      localStream?.getAudioTracks().length ?? 0,
    );
    // eslint-disable-next-line no-console
    console.log(
      "[LATE-TRACK] videoTracks =",
      localStream?.getVideoTracks().length ?? 0,
    );
    // eslint-disable-next-line no-console
    console.log("[LATE-TRACK] peers =", peersRef.current.size);

    if (!localStream) {
      return;
    }

    peersRef.current.forEach((pc, userId) => {
      // eslint-disable-next-line no-console
      console.log(`[LATE-TRACK][${userId}] peer connection found`, {
        signalingState: pc.signalingState,
      });

      const senders = pc.getSenders();
      const audioTrack = localStream.getAudioTracks()[0];
      const videoTrack = localStream.getVideoTracks()[0];
      let addedNewTrack = false;

      // eslint-disable-next-line no-console
      console.log(`[LATE-TRACK][${userId}] local tracks =`, {
        audioTrack: audioTrack ? { enabled: audioTrack.enabled, readyState: audioTrack.readyState } : null,
        videoTrack: videoTrack ? { enabled: videoTrack.enabled, readyState: videoTrack.readyState } : null,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[LATE-TRACK][${userId}] existing senders =`,
        senders.map((s) => s.track?.kind ?? "none"),
      );

      if (audioTrack) {
        const audioSender = senders.find((s) => s.track?.kind === "audio");
        if (audioSender) {
          audioSender.replaceTrack(audioTrack).catch(() => {
            /* ignored */
          });
        } else {
          pc.addTrack(audioTrack, localStream);
          addedNewTrack = true;
          // eslint-disable-next-line no-console
          console.log(`[LATE-TRACK][${userId}] addTrack audio`);
        }
      }

      if (videoTrack) {
        const videoSender = senders.find((s) => s.track?.kind === "video");
        if (videoSender) {
          videoSender.replaceTrack(videoTrack).catch(() => {
            /* ignored */
          });
        } else {
          pc.addTrack(videoTrack, localStream);
          addedNewTrack = true;
          // eslint-disable-next-line no-console
          console.log(`[LATE-TRACK][${userId}] addTrack video`);
        }
      }

      // A brand-new track added to a connection that already finished its
      // initial negotiation (e.g. the camera/mic only became ready after
      // the first answer had already been sent with no local tracks) needs
      // a fresh offer/answer round — addTrack alone never reaches the
      // remote peer without one. Only fires for a genuinely new sender
      // (never for audio calls, whose tracks are already present at the
      // very first negotiation), and only from a clean "stable" state to
      // avoid glare with an in-flight negotiation.
      // eslint-disable-next-line no-console
      console.log(`[LATE-TRACK][${userId}] renegotiation condition =`, {
        addedNewTrack,
        signalingState: pc.signalingState,
        willRenegotiate: addedNewTrack && pc.signalingState === "stable",
      });

      if (addedNewTrack && pc.signalingState === "stable") {
        // eslint-disable-next-line no-console
        console.log(`[LATE-TRACK][${userId}] triggering renegotiation`);
        logWebRTC(userId, "renegotiating after adding late local track(s)");
        // eslint-disable-next-line no-console
        console.log(`[LATE-TRACK][${userId}] makeOffer called`);
        makeOffer(userId);
      }
    });
  }, [localStream, makeOffer, logWebRTC]);

  useEffect(() => {
    return () => {
      closeAllConnections();
    };
  }, [closeAllConnections]);

  return {
    peers,
    remoteStreams,
    connectionErrors,
    connectedPeers,
    createPeerConnection,
    makeOffer,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    closePeerConnection,
    closeAllConnections,
  };
}
