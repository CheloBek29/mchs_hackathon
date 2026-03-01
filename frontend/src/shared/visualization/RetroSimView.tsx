import { useEffect, useRef } from 'react';
import { adaptBundleToRetroSnapshot } from '../../lib/retroBundleToSnapshot.js';
import { RetroSimRenderer } from '../../lib/renderer-retro/index.js';
import type { RetroQualityLevel } from '../../lib/renderer-retro/types.js';
import type { SessionStateBundleDto } from '../api/types';

interface RetroSimViewProps {
  bundle: SessionStateBundleDto | null;
  className?: string;
  quality?: RetroQualityLevel;
}

export function RetroSimView({
  bundle,
  className,
  quality = 'balanced',
}: RetroSimViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<RetroSimRenderer | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let renderer: RetroSimRenderer;
    try {
      renderer = new RetroSimRenderer(container, {
        initialQuality: quality,
        antialias: false,
        backgroundColor: 0x020309,
      });
      rendererRef.current = renderer;
      renderer.start();
    } catch (error) {
      console.error('[RetroSimView] Failed to initialize renderer', error);
      return;
    }

    return () => {
      renderer.stop();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [quality]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !bundle) {
      return;
    }

    try {
      const snapshot = adaptBundleToRetroSnapshot(bundle);
      renderer.setSnapshot(snapshot);
    } catch (error) {
      console.error('[RetroSimView] setSnapshot error', error);
    }
  }, [bundle]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%', overflow: 'hidden', background: '#06080f' }}
    />
  );
}
