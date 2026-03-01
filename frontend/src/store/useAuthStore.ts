import { create } from 'zustand';

export interface UserRoleDto {
  id: number;
  name: string;
}

export interface UserProfile {
  id: string;
  username: string;
  email?: string;
  roles: UserRoleDto[];
  avatar_url?: string | null;
  session_id?: string | null;
  is_active?: boolean;
  is_mfa_enabled?: boolean;
}

interface AuthState {
  token: string | null;
  user: UserProfile | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  setCredentials: (token: string, user: UserProfile) => void;
  setUser: (user: UserProfile | null) => void;
  logout: () => void;
  setLoading: (isLoading: boolean) => void;
}

const getInitialToken = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem('auth_token');
};

const initialToken = getInitialToken();

export const useAuthStore = create<AuthState>((set) => ({
  token: initialToken,
  user: null,
  isAuthenticated: Boolean(initialToken),
  isLoading: true,

  setCredentials: (token, user) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('auth_token', token);
    }
    set({ token, user, isAuthenticated: true, isLoading: false });
  },

  setUser: (user) => {
    set({ user, isAuthenticated: user ? true : false });
  },

  logout: () => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('auth_token');
    }
    set({ token: null, user: null, isAuthenticated: false, isLoading: false });
  },

  setLoading: (isLoading) => {
    set({ isLoading });
  },
}));
