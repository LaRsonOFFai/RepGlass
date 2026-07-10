/// <reference types="vite/client" />

import type { GlassApi } from '../preload';

declare global {
  interface Window {
    glass: GlassApi;
  }
}
