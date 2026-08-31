import { useState, useEffect, useCallback } from "react";

export type CallType = "audio" | "video";

export function useMediaStream(callType: CallType | null) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);

  const startStream = useCallback(
    async (overrideCallType?: CallType) => {
      const typeToUse = overrideCallType || callType;

      if (!typeToUse) {
        return;
      }

      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }

      setIsLoading(true);
      setError(null);

      // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change. Remove
      // once the accept-to-connected delay has been root-caused.
      const __callTimingStartStreamBeginTs = Date.now();
      console.log(
        `[CALL-TIMING] startStream begin t=${__callTimingStartStreamBeginTs} type=${typeToUse}`,
      );
      let __callTimingGumBeginTs = __callTimingStartStreamBeginTs;

      try {
        const constraints: MediaStreamConstraints = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video:
            typeToUse === "video"
              ? {
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                  facingMode: "user",
                }
              : false,
        };

        // TEMPORARY DEBUG LOGGING — remove once the local-stream regression is confirmed fixed.
        // eslint-disable-next-line no-console
        console.log(
          "[MEDIA] getUserMedia requested video=",
          typeToUse === "video",
          "audio=",
          true,
        );

        // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change.
        __callTimingGumBeginTs = Date.now();
        console.log(
          `[CALL-TIMING] getUserMedia begin t=${__callTimingGumBeginTs} video=${typeToUse === "video"} audio=true elapsedFromStartStream=${__callTimingGumBeginTs - __callTimingStartStreamBeginTs}ms`,
        );

        const mediaStream =
          await navigator.mediaDevices.getUserMedia(constraints);

        // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change.
        const __callTimingGumSuccessTs = Date.now();
        console.log(
          `[CALL-TIMING] getUserMedia success t=${__callTimingGumSuccessTs} elapsedFromGumBegin=${__callTimingGumSuccessTs - __callTimingGumBeginTs}ms elapsedFromStartStream=${__callTimingGumSuccessTs - __callTimingStartStreamBeginTs}ms audioTracks=${mediaStream.getAudioTracks().length} videoTracks=${mediaStream.getVideoTracks().length}`,
        );

        // eslint-disable-next-line no-console
        console.log(
          "[MEDIA] getUserMedia success audioTracks=",
          mediaStream.getAudioTracks().length,
          "videoTracks=",
          mediaStream.getVideoTracks().length,
        );

        mediaStream.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });

        if (callType === "video") {
          mediaStream.getVideoTracks().forEach((track) => {
            track.enabled = true;
          });
        }

        setStream(mediaStream);
        setAudioEnabled(true);
        setVideoEnabled(typeToUse === "video");
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.log("[MEDIA] getUserMedia FAILED", err?.name, err?.message);

        // TEMPORARY DIAGNOSTIC LOGGING — timing-only, no logic change.
        const __callTimingGumFailedTs = Date.now();
        console.log(
          `[CALL-TIMING] getUserMedia failed t=${__callTimingGumFailedTs} elapsedFromGumBegin=${__callTimingGumFailedTs - __callTimingGumBeginTs}ms elapsedFromStartStream=${__callTimingGumFailedTs - __callTimingStartStreamBeginTs}ms name=${err?.name} message=${err?.message}`,
        );

        // Video calls request audio+video in a single combined getUserMedia
        // call, which fails atomically: a camera-only problem (e.g. the
        // device already in use) rejects the whole promise and the
        // microphone is never acquired either, even though it may be
        // perfectly available on its own. Retry with audio-only before
        // surfacing an error, so the call can proceed with working audio
        // and no video instead of failing outright.
        if (typeToUse === "video") {
          try {
            console.log(
              "[MEDIA] video getUserMedia failed — retrying audio-only fallback",
            );
            const audioOnlyStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
              video: false,
            });

            console.log(
              "[MEDIA] audio-only fallback succeeded audioTracks=",
              audioOnlyStream.getAudioTracks().length,
            );

            audioOnlyStream.getAudioTracks().forEach((track) => {
              track.enabled = true;
            });

            setStream(audioOnlyStream);
            setAudioEnabled(true);
            setVideoEnabled(false);
            setError(null);
            return;
          } catch (fallbackErr: any) {
            console.log(
              "[MEDIA] audio-only fallback FAILED",
              fallbackErr?.name,
              fallbackErr?.message,
            );
            // Fall through to the existing error handling below, reporting
            // the original video-attempt error (unchanged behavior when
            // there is truly no usable device at all).
          }
        }

        let errorMessage =
          "Erreur lors de l'accès aux périphériques multimédias.";

        if (
          err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError"
        ) {
          errorMessage =
            "Permission refusée. Veuillez autoriser l'accès à votre caméra/microphone dans les paramètres du navigateur.";
        } else if (
          err.name === "NotFoundError" ||
          err.name === "DevicesNotFoundError"
        ) {
          errorMessage = `Aucun ${typeToUse === "video" ? "caméra/microphone" : "microphone"} trouvé. Vérifiez que votre appareil est connecté.`;
        } else if (
          err.name === "NotReadableError" ||
          err.name === "TrackStartError"
        ) {
          errorMessage =
            "Impossible d'accéder à l'appareil. Il est peut-être déjà utilisé par une autre application.";
        } else if (
          err.name === "OverconstrainedError" ||
          err.name === "ConstraintNotSatisfiedError"
        ) {
          errorMessage =
            "Les paramètres de l'appareil ne sont pas compatibles. Essayez un autre appareil.";
        } else if (err.name === "TypeError") {
          errorMessage =
            "Votre navigateur ne supporte pas l'accès aux périphériques multimédias.";
        } else if (err.message) {
          errorMessage = `Erreur: ${err.message}`;
        }

        setError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [callType, stream],
  );

  const stopStream = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      setStream(null);
      setAudioEnabled(false);
      setVideoEnabled(false);
    }
  }, [stream]);

  const toggleAudio = useCallback(() => {
    if (stream) {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        return false;
      }

      const newState = !audioTracks[0].enabled;
      audioTracks.forEach((track) => {
        track.enabled = newState;
      });

      setAudioEnabled(newState);
      return newState;
    }
    return false;
  }, [stream]);

  const toggleVideo = useCallback(() => {
    if (stream) {
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length === 0) {
        return false;
      }

      const newState = !videoTracks[0].enabled;
      videoTracks.forEach((track) => {
        track.enabled = newState;
      });

      setVideoEnabled(newState);
      return newState;
    }
    return false;
  }, [stream]);

  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [stream]);

  return {
    stream,
    error,
    isLoading,
    startStream,
    stopStream,
    toggleAudio,
    toggleVideo,
    isAudioEnabled: audioEnabled,
    isVideoEnabled: videoEnabled,
  };
}
