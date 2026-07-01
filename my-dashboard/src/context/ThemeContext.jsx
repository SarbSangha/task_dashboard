import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const THEME_STORAGE_KEY = 'rmw-dashboard-theme';
const DEFAULT_THEME = 'dark';

const ThemeContext = createContext(null);

const getStoredTheme = () => {
  try {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : null;
  } catch {
    return null;
  }
};

const resolveThemePreference = () => {
  if (typeof window === 'undefined') {
    return DEFAULT_THEME;
  }

  const savedTheme = getStoredTheme();
  if (savedTheme) {
    return savedTheme;
  }

  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }

  return DEFAULT_THEME;
};

const applyThemeToDocument = (theme) => {
  if (typeof document === 'undefined') {
    return;
  }

  document.body.classList.remove('theme-light', 'theme-dark');
  document.body.classList.add(`theme-${theme}`, 'theme-ready');
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
};

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(resolveThemePreference);

  useEffect(() => {
    applyThemeToDocument(theme);

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage write failures and keep the active in-memory theme.
    }
  }, [theme]);

  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key !== THEME_STORAGE_KEY) {
        return;
      }

      const nextTheme = event.newValue === 'light' || event.newValue === 'dark'
        ? event.newValue
        : resolveThemePreference();

      setTheme((currentTheme) => (currentTheme === nextTheme ? currentTheme : nextTheme));
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const value = useMemo(
    () => ({
      theme,
      isDarkMode: theme === 'dark',
      setTheme,
      toggleTheme: () => {
        setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark'));
      },
    }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
};
