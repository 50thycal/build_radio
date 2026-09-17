'use client';

/**
 * Episode player.
 *
 * Built for a thumb: a large play target, ±15 second skips either side of it,
 * a full-width scrubber, and speed controls below. Listening position is
 * remembered per episode in localStorage and restored on return — the single
 * feature that makes a private feed feel like a real podcast app.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/lib/cost';

const SPEEDS = [0.9, 1, 1.25, 1.5, 1.75, 2];
const SKIP_SECONDS = 15;
/** Below this we treat the episode as unstarted rather than resuming at 0:03. */
const RESUME_FLOOR_SECONDS = 15;
/** Within this of the end, start again from the beginning. */
const RESUME_CEILING_SECONDS = 20;

type Props = {
  slug: string;
  src: string;
  /** Duration measured at render time; used until metadata loads. */
  durationSeconds: number | null;
  title: string;
};

function positionKey(slug: string): string {
  return `bor:position:${slug}`;
}

function speedKey(): string {
  return 'bor:speed';
}

function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null; // private mode, blocked storage: play without memory
  }
}

function writeNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

export function AudioPlayer({ slug, src, durationSeconds, title }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationSeconds ?? 0);
  const [speed, setSpeed] = useState(1);
  const [isScrubbing, setIsScrubbing] = useState(false);

  // Restore position and speed once the element exists.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const savedSpeed = readNumber(speedKey());
    if (savedSpeed && SPEEDS.includes(savedSpeed)) {
      setSpeed(savedSpeed);
      audio.playbackRate = savedSpeed;
    }
    const savedPosition = readNumber(positionKey(slug));
    if (savedPosition && savedPosition > RESUME_FLOOR_SECONDS) {
      audio.currentTime = savedPosition;
      setCurrentTime(savedPosition);
    }
  }, [slug]);

  // Persist position roughly every five seconds of playback.
  const lastSaved = useRef(0);
  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!isScrubbing) setCurrentTime(audio.currentTime);
    if (Math.abs(audio.currentTime - lastSaved.current) >= 5) {
      lastSaved.current = audio.currentTime;
      const remaining = (audio.duration || duration) - audio.currentTime;
      writeNumber(positionKey(slug), remaining < RESUME_CEILING_SECONDS ? 0 : audio.currentTime);
    }
  }, [duration, isScrubbing, slug]);

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        // iOS refuses playback outside a user gesture; the button is the gesture.
        setIsPlaying(false);
      }
    } else {
      audio.pause();
    }
  }, []);

  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const target = Math.min(Math.max(audio.currentTime + seconds, 0), audio.duration || duration || 0);
    audio.currentTime = target;
    setCurrentTime(target);
  }, [duration]);

  const changeSpeed = useCallback((value: number) => {
    const audio = audioRef.current;
    setSpeed(value);
    writeNumber(speedKey(), value);
    if (audio) audio.playbackRate = value;
  }, []);

  const seekTo = useCallback((value: number) => {
    const audio = audioRef.current;
    setCurrentTime(value);
    if (audio) audio.currentTime = value;
  }, []);

  const effectiveDuration = duration || durationSeconds || 0;
  const progress = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0;

  return (
    <div className="player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
          event.currentTarget.playbackRate = speed;
        }}
        onTimeUpdate={handleTimeUpdate}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          writeNumber(positionKey(slug), 0);
        }}
      />

      <input
        className="scrubber"
        type="range"
        min={0}
        max={Math.max(effectiveDuration, 1)}
        step={1}
        value={Math.min(currentTime, effectiveDuration || 1)}
        style={{ ['--progress' as string]: `${progress}%` }}
        aria-label={`Seek within ${title}`}
        onPointerDown={() => setIsScrubbing(true)}
        onPointerUp={() => setIsScrubbing(false)}
        onChange={(event) => seekTo(Number(event.target.value))}
      />

      <div className="time-row">
        <span>{formatDuration(currentTime)}</span>
        <span>-{formatDuration(Math.max(effectiveDuration - currentTime, 0))}</span>
      </div>

      <div className="transport">
        <button type="button" className="skip" onClick={() => skip(-SKIP_SECONDS)} aria-label="Back 15 seconds">
          ↺ 15
        </button>
        <button
          type="button"
          className="primary"
          onClick={toggle}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          aria-pressed={isPlaying}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            {isPlaying ? (
              <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
            ) : (
              <path d="M8 5.5v13a.75.75 0 0 0 1.14.64l10.5-6.5a.75.75 0 0 0 0-1.28L9.14 4.86A.75.75 0 0 0 8 5.5z" />
            )}
          </svg>
        </button>
        <button type="button" className="skip" onClick={() => skip(SKIP_SECONDS)} aria-label="Forward 15 seconds">
          15 ↻
        </button>
      </div>

      <div className="speed-row">
        {SPEEDS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={speed === value}
            onClick={() => changeSpeed(value)}
          >
            {value}×
          </button>
        ))}
      </div>
    </div>
  );
}
