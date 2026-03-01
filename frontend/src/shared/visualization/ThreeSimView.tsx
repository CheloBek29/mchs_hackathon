import { useEffect, useRef } from 'react';
import { TPSimRenderer } from '../../lib/renderer-three/render/TPSimRenderer.js';
import { adaptBundleToRenderSnapshot } from '../../lib/bundleToRenderSnapshot.js';
import type { RendererOptions } from '../../lib/renderer-three/types.js';
import type { SessionStateBundleDto } from '../api/types';

interface ThreeSimViewProps {
  bundle: SessionStateBundleDto | null;
  className?: string;
  quality?: RendererOptions['initialQuality'];
  autoQuality?: boolean;
}

export function ThreeSimView({
  bundle,
  className,
  quality = 'medium',
  autoQuality = true,
}: ThreeSimViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TPSimRenderer | null>(null);

  // Mount renderer once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: TPSimRenderer;
    try {
      renderer = new TPSimRenderer(container, {
        initialQuality: quality,
        autoQuality,
        antialias: true,
        shadowMap: quality === 'ultra' || quality === 'high',
      });
      rendererRef.current = renderer;
      renderer.start();
    } catch (err) {
      console.error('[ThreeSimView] Failed to initialize renderer:', err);
      return;
    }

    return () => {
      renderer.stop();
      renderer.dispose();
      rendererRef.current = null;
    };
    // Only re-run if quality level changes (not bundle — handled separately below)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality]);

  // Sync bundle → snapshot
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !bundle) return;
    try {
      const snapshot = adaptBundleToRenderSnapshot(bundle);
      renderer.setSnapshot(snapshot);
    } catch (err) {
      console.error('[ThreeSimView] setSnapshot error:', err);
    }
  }, [bundle]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%', overflow: 'hidden', background: '#0a0e18' }}
    />
  );
}
