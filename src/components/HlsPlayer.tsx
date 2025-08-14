import React, { useRef, useEffect } from 'react';
import Hls from 'hls.js';

export interface LiveHlsPlayerProps {
  /** HLS playlist URL — can be an absolute URL on your backend or a relative path served by the frontend */
  src?: string;
  className?: string;
  autoPlay?: boolean;
  muted?: boolean;
  /** optional SSE endpoint on the backend that emits {type:'playlist-updated'} events */
  eventsUrl?: string | null;
  /** crossOrigin attribute for the <video> element when loading from other origin */
  crossOrigin?: 'anonymous' | 'use-credentials' | undefined;
}

// TypeScript + React HLS player that supports backend-hosted playlists (different folder/origin)
// Usage examples:
// <LiveHlsPlayer src="https://192.168.1.10:3000/streams/stream.m3u8" eventsUrl="https://192.168.1.10:3000/events" />

export default function LiveHlsPlayer({
  src = '/public/stream.m3u8',
  className = '',
  autoPlay = true,
  muted = true,
  eventsUrl = null,
  crossOrigin = 'anonymous',
}: LiveHlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // ensure crossOrigin is set before attaching media when loading from another origin
    if (crossOrigin) video.crossOrigin = crossOrigin;

    // cleanup previous instance
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch (e) {
        // ignore
      }
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true });
      hlsRef.current = hls;
      hls.attachMedia(video);

      const onMediaAttached = () => {
        try {
          hls.loadSource(src);
        } catch (e) {
          console.error('hls.loadSource error', e);
        }
      };

      hls.on(Hls.Events.MEDIA_ATTACHED, onMediaAttached);

      const onError = (event: string, data: any) => {
        console.error('hls error', event, data);
      };
      hls.on(Hls.Events.ERROR, onError);

      return () => {
        try {
          hls.off(Hls.Events.ERROR, onError as any);
          hls.off(Hls.Events.MEDIA_ATTACHED, onMediaAttached as any);
        } catch (e) {}
        try { hls.destroy(); } catch (e) {}
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // native HLS (Safari)
      video.src = src;
    } else {
      console.error('HLS not supported in this browser');
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, crossOrigin]);


  function handleReload() {
    const hls = hlsRef.current;
    if (hls) {
      try {
        hls.stopLoad();
        hls.startLoad(0);
        hls.loadSource(src);
      } catch (e) {
        console.error('reload failed', e);
      }
    } else if (videoRef.current) {
      try { videoRef.current.load(); } catch (e) { /* ignore */ }
    }
  }

  return (
    <div className={` max-w-xl h-96 mx-auto mt-20 rounded-2xl ${className} `} >
      <video
        ref={videoRef}
        className="w-full bg-black h-80 rounded-2xl"
        controls
        autoPlay={autoPlay}
        muted={muted}
        playsInline
      />


      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={handleReload}
          className="px-3 py-1 rounded bg-blue-400 font-sans font-medium text-md text-white text-sm"
          type="button"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
