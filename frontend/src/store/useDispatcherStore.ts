import { create } from 'zustand';

interface DispatcherUiState {
  bannerText: string;
  showBanner: (text: string, durationMs?: number) => void;
  clearBanner: () => void;
}

let bannerTimer: ReturnType<typeof setTimeout> | null = null;

export const useDispatcherStore = create<DispatcherUiState>((set) => ({
  bannerText: '',

  showBanner: (text: string, durationMs = 3500) => {
    if (bannerTimer) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }

    set({ bannerText: text });

    bannerTimer = setTimeout(() => {
      set({ bannerText: '' });
      bannerTimer = null;
    }, durationMs);
  },

  clearBanner: () => {
    if (bannerTimer) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
    set({ bannerText: '' });
  },
}));
