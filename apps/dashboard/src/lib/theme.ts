import { useEffect, useState } from 'react';

/** Increments whenever the OS color scheme flips (canvas must re-resolve colors). */
export function useColorSchemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setV((n) => n + 1);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return v;
}

/** Device pixel ratio, tracked across monitor/zoom changes. */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    const update = () => {
      setDpr(window.devicePixelRatio || 1);
      mq?.removeEventListener('change', update);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', update);
    };
    update();
    return () => mq?.removeEventListener('change', update);
  }, []);
  return dpr;
}
