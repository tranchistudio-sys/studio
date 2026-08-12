import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ListMusic, Pause, Play, Volume2, VolumeX, X } from "lucide-react";

const TRACKS = Array.from({ length: 8 }, (_, index) => ({
  title: `Nhạc cưới ${index + 1}`,
  src: `/audio/wedding/track-${String(index + 1).padStart(2, "0")}.mp3`,
}));

const MUSIC_ENABLED_KEY = "weddingMusicEnabled_v1";

export function WeddingMusicPlayer() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [trackIndex, setTrackIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(() => localStorage.getItem(MUSIC_ENABLED_KEY) !== "0");
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const play = async () => {
    if (!enabled) {
      setEnabled(true);
      localStorage.setItem(MUSIC_ENABLED_KEY, "1");
    }
    try {
      await audioRef.current?.play();
      setPlaying(true);
      setAutoplayBlocked(false);
    } catch {
      setPlaying(false);
      setAutoplayBlocked(true);
    }
  };

  const pause = () => {
    audioRef.current?.pause();
    setPlaying(false);
  };

  const toggle = () => {
    if (playing) {
      pause();
      setEnabled(false);
      localStorage.setItem(MUSIC_ENABLED_KEY, "0");
    } else {
      void play();
    }
  };

  const selectTrack = (index: number) => {
    setTrackIndex((index + TRACKS.length) % TRACKS.length);
    setEnabled(true);
    localStorage.setItem(MUSIC_ENABLED_KEY, "1");
  };

  useEffect(() => {
    if (enabled) void play();
    return () => audioRef.current?.pause();
    // Autoplay is intentionally attempted once when the wedding module opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (enabled) void play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackIndex]);

  return (
    <div className="wc-music-player">
      <audio
        ref={audioRef}
        src={TRACKS[trackIndex].src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => selectTrack(trackIndex + 1)}
      />

      {open && (
        <div className="wc-music-panel" role="dialog" aria-label="Danh sách nhạc cưới">
          <div className="wc-music-panel-head">
            <div><strong>Nhạc cưới</strong><span>8 bài của Amazing Studio</span></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Đóng danh sách"><X /></button>
          </div>
          <div className="wc-music-track-list">
            {TRACKS.map((track, index) => (
              <button key={track.src} type="button" onClick={() => selectTrack(index)} className={index === trackIndex ? "is-active" : ""}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{track.title}</strong>
                {index === trackIndex && (playing ? <Volume2 /> : <Pause />)}
              </button>
            ))}
          </div>
        </div>
      )}

      <button type="button" className={`wc-music-disc ${playing ? "is-playing" : ""}`} onClick={toggle} aria-label={playing ? "Tắt nhạc" : "Bật nhạc"} title={playing ? "Tắt nhạc" : "Bật nhạc"}>
        <span className="wc-music-disc-rings" />
        <span className="wc-music-disc-center">{playing ? <Volume2 /> : <VolumeX />}</span>
      </button>
      <div className="wc-music-mini-controls">
        <button type="button" onClick={() => selectTrack(trackIndex - 1)} aria-label="Bài trước"><ChevronLeft /></button>
        <button type="button" onClick={toggle} aria-label={playing ? "Tạm dừng" : "Phát nhạc"}>{playing ? <Pause /> : <Play />}</button>
        <button type="button" onClick={() => selectTrack(trackIndex + 1)} aria-label="Bài tiếp"><ChevronRight /></button>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-label="Danh sách nhạc"><ListMusic /></button>
      </div>
      <p className="wc-music-label">{autoplayBlocked ? "Chạm đĩa để bật nhạc" : TRACKS[trackIndex].title}</p>
    </div>
  );
}
