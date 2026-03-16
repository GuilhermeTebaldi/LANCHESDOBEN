/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { startTransition, useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { 
  Menu as MenuIcon, 
  X, 
  ShoppingBag, 
  Instagram, 
  Facebook, 
  MapPin, 
  Phone, 
  Clock,
  Star,
  Lock,
  Eye,
  EyeOff
} from 'lucide-react';
import {
  fetchPublicProducts,
  readCachedPublicProducts,
  type PublicProduct,
} from './services/publicCatalog';
import DeveloperPortal from './developer/DeveloperPortal';
import ErrorMonitorPortal from './developer/ErrorMonitorPortal';

const ADMIN_EMAIL = 'meu@admin.com';
const ADMIN_PASSWORD = 'ben123';
const PRODUCTION_FALLBACK_ORIGIN = 'https://lanchesdoben.com.br';
const ADMIN_GATE_KEY = 'lanchesdoben_admin_gate';
const ADMIN_REMEMBER_ACCESS_KEY = 'lanchesdoben_admin_remember_access';
const ADMIN_SAVED_EMAIL_KEY = 'lanchesdoben_admin_saved_email';
let hasPlayedHeroCtaIntro = false;

const normalizePath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const withPath = (origin: string, path: string) => {
  const normalizedPath = normalizePath(path);
  if (normalizedPath === '/') return origin;
  return `${origin}${normalizedPath}`;
};

const resolveAdminSystemUrl = () => {
  const systemPath = normalizePath(
    (import.meta.env.VITE_ADMIN_SYSTEM_PATH as string | undefined) || '/sistema/'
  );

  if (typeof window !== 'undefined') {
    return withPath(window.location.origin, systemPath);
  }

  return withPath(PRODUCTION_FALLBACK_ORIGIN, systemPath);
};

const PRODUCT_CATEGORY_LABELS: Record<string, string> = {
  Snack: 'Lanche',
  Drink: 'Bebida',
  Side: 'Acompanhamento',
  Combo: 'Combo',
};

const BRL_CURRENCY_FORMATTER = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const resolveProductCategoryLabel = (category: string) =>
  PRODUCT_CATEGORY_LABELS[category] || category;

const readRememberAdminAccess = (): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(ADMIN_REMEMBER_ACCESS_KEY) !== '0';
  } catch {
    return true;
  }
};

const persistRememberAdminAccess = (value: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ADMIN_REMEMBER_ACCESS_KEY, value ? '1' : '0');
  } catch {
    // ignore storage write failures
  }
};

const readSavedAdminEmail = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    return (window.localStorage.getItem(ADMIN_SAVED_EMAIL_KEY) || '').trim().toLowerCase();
  } catch {
    return '';
  }
};

const persistSavedAdminEmail = (email: string): void => {
  if (typeof window === 'undefined') return;
  const normalizedEmail = email.trim().toLowerCase();
  try {
    if (!normalizedEmail) {
      window.localStorage.removeItem(ADMIN_SAVED_EMAIL_KEY);
      return;
    }
    window.localStorage.setItem(ADMIN_SAVED_EMAIL_KEY, normalizedEmail);
  } catch {
    // ignore storage write failures
  }
};

const areProductsEqual = (current: PublicProduct[], next: PublicProduct[]): boolean => {
  if (current.length !== next.length) return false;

  for (let index = 0; index < current.length; index += 1) {
    const currentProduct = current[index];
    const nextProduct = next[index];
    if (
      currentProduct.id !== nextProduct.id ||
      currentProduct.name !== nextProduct.name ||
      currentProduct.price !== nextProduct.price ||
      currentProduct.imageUrl !== nextProduct.imageUrl ||
      currentProduct.category !== nextProduct.category
    ) {
      return false;
    }
  }

  return true;
};

const isDeveloperRoute = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/desenvolvedor');
};

const isErrorMonitorRoute = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/rede');
};

function MainSiteApp() {
  const prefersReducedMotion = useReducedMotion();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isAdminModalOpen, setIsAdminModalOpen] = useState(false);
  const [isHoursOpen, setIsHoursOpen] = useState(false);
  const [playHeroCtaIntro, setPlayHeroCtaIntro] = useState(() => {
    if (prefersReducedMotion) return false;
    if (hasPlayedHeroCtaIntro) return false;
    hasPlayedHeroCtaIntro = true;
    return true;
  });
  const [isAdminPasswordVisible, setIsAdminPasswordVisible] = useState(false);
  const [rememberAdminAccess, setRememberAdminAccess] = useState(readRememberAdminAccess);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminError, setAdminError] = useState('');
  const [isAdminRedirecting, setIsAdminRedirecting] = useState(false);
  const [publicProducts, setPublicProducts] = useState<PublicProduct[]>([]);
  const [isProductsLoading, setIsProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState('');

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isMenuOpen]);

  useEffect(() => {
    let isActive = true;
    let isRefreshing = false;

    const loadProducts = async (isInitialLoad: boolean) => {
      if (isRefreshing) return;
      isRefreshing = true;

      if (isInitialLoad && isActive) {
        setIsProductsLoading(true);
      }

      try {
        const loadedProducts = await fetchPublicProducts();
        if (!isActive) return;
        startTransition(() => {
          setPublicProducts((currentProducts) =>
            areProductsEqual(currentProducts, loadedProducts) ? currentProducts : loadedProducts
          );
          setProductsError('');
        });
      } catch {
        if (!isActive) return;
        setProductsError('Cardápio indisponível no momento. Tente novamente em instantes.');
      } finally {
        isRefreshing = false;
        if (isInitialLoad && isActive) {
          setIsProductsLoading(false);
        }
      }
    };

    const cachedProducts = readCachedPublicProducts();
    if (cachedProducts.length > 0) {
      setPublicProducts(cachedProducts);
      setIsProductsLoading(false);
    }

    void loadProducts(cachedProducts.length === 0);

    // Mantém o cardápio sincronizado com as alterações do sistema sem forçar recarregamento manual.
    const refreshIntervalId = window.setInterval(() => {
      if (document.hidden) return;
      void loadProducts(false);
    }, 45000);

    const refreshOnFocus = () => {
      void loadProducts(false);
    };
    const refreshOnVisibility = () => {
      if (!document.hidden) {
        void loadProducts(false);
      }
    };

    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);

    return () => {
      isActive = false;
      window.clearInterval(refreshIntervalId);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, []);

  const openAdminModal = () => {
    if (typeof window !== 'undefined') {
      try {
        const hasRememberedAccess = window.localStorage.getItem(ADMIN_GATE_KEY) === 'authenticated';
        if (hasRememberedAccess) {
          window.sessionStorage.setItem(ADMIN_GATE_KEY, 'authenticated');
          window.location.href = resolveAdminSystemUrl();
          return;
        }
      } catch {
        // ignore storage read failures and continue with manual login
      }
    }

    setAdminEmail(readSavedAdminEmail());
    setAdminPassword('');
    setIsAdminPasswordVisible(false);
    setAdminError('');
    setIsAdminModalOpen(true);
  };

  const closeAdminModal = () => {
    setIsAdminModalOpen(false);
    setAdminPassword('');
    setIsAdminPasswordVisible(false);
    setAdminError('');
    setIsAdminRedirecting(false);
  };

  const handleAdminLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (isAdminRedirecting) return;

    const normalizedEmail = adminEmail.trim().toLowerCase();

    if (normalizedEmail === ADMIN_EMAIL && adminPassword === ADMIN_PASSWORD) {
      setIsAdminRedirecting(true);
      setAdminError('');
      persistRememberAdminAccess(rememberAdminAccess);
      if (rememberAdminAccess) {
        persistSavedAdminEmail(normalizedEmail);
      } else {
        persistSavedAdminEmail('');
      }
      try {
        window.sessionStorage.setItem(ADMIN_GATE_KEY, 'authenticated');
      } catch {
        // ignore storage write failures
      }
      try {
        if (rememberAdminAccess) {
          window.localStorage.setItem(ADMIN_GATE_KEY, 'authenticated');
        } else {
          window.localStorage.removeItem(ADMIN_GATE_KEY);
        }
      } catch {
        // ignore storage write failures
      }
      const targetUrl = resolveAdminSystemUrl();
      window.location.href = targetUrl;
      setIsAdminRedirecting(false);
      setIsAdminModalOpen(false);
      return;
    }

    setAdminError('E-mail ou senha inválidos.');
    setAdminPassword('');
  };

  const handleWhatsApp = () => {
    const message = encodeURIComponent("Olá! Gostaria de fazer um pedido.");
    window.open(`https://wa.me/5521983659826?text=${message}`, '_blank');
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Navigation */}
      <nav className="fixed w-full z-50 bg-brand-black/95 text-white border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-20">
            <div className="flex items-center gap-3">
              <img 
                src="https://i.pinimg.com/736x/69/40/d9/6940d97853972edd36dd7e77a4a99bc9.jpg" 
                alt="Logo LANCHESDOBEN" 
                className="w-12 h-12 rounded-full object-cover border-2 border-brand-red"
                loading="eager"
                decoding="async"
                fetchPriority="high"
                referrerPolicy="no-referrer"
              />
              <span className="font-display text-3xl tracking-tighter text-brand-red">LANCHESDOBEN</span>
            </div>
            
            <div className="hidden md:flex items-center space-x-8">
              <a href="#home" className="hover:text-brand-red transition-colors">Início</a>
              <div className="flex items-center gap-4 border-l border-white/20 pl-8">
                <a 
                  href="https://www.instagram.com/lanches.doben/" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="hover:text-brand-red transition-colors"
                >
                  <Instagram size={20} />
                </a>
                <a 
                  href="https://www.facebook.com/lanches.dobem.2025?mibextid=wwXIfr&rdid=joCIhkS38u0Amnma&share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2F1C8gGroWcL%2F%3Fmibextid%3DwwXIfr%26ref%3D1#" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="hover:text-brand-red transition-colors"
                >
                  <Facebook size={20} />
                </a>
              </div>
              <button 
                onClick={openAdminModal}
                className="hover:text-brand-red transition-colors flex items-center gap-2"
              >
                <Lock size={16} />
                Admin
              </button>
              <button
                onClick={handleWhatsApp}
                className="bg-brand-red hover:bg-red-700 text-white px-6 py-2 rounded-full font-bold transition-all flex items-center gap-2"
              >
                <ShoppingBag size={20} />
                Pedir Agora
              </button>
            </div>

            <div className="md:hidden flex items-center">
              <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="p-2">
                {isMenuOpen ? <X size={28} /> : <MenuIcon size={28} />}
              </button>
            </div>
          </div>
        </div>

      </nav>

      {/* Mobile Side Menu */}
      <AnimatePresence>
        {isMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMenuOpen(false)}
              className="md:hidden fixed inset-0 z-[70] bg-brand-black/70 backdrop-blur-sm"
              aria-hidden="true"
            />
            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="md:hidden fixed top-0 right-0 z-[80] h-screen w-[85%] max-w-sm bg-brand-black border-l border-white/10 shadow-2xl"
              role="dialog"
              aria-modal="true"
              aria-label="Menu mobile"
            >
              <div className="h-20 px-4 border-b border-white/10 flex items-center justify-between">
                <span className="font-display text-3xl tracking-tighter text-brand-red">MENU</span>
                <button
                  onClick={() => setIsMenuOpen(false)}
                  className="p-2 text-white hover:text-brand-red transition-colors"
                  aria-label="Fechar menu"
                >
                  <X size={28} />
                </button>
              </div>

              <div className="px-4 py-6 space-y-6">
                <a
                  href="#home"
                  onClick={() => setIsMenuOpen(false)}
                  className="block text-lg font-medium text-white hover:text-brand-red transition-colors"
                >
                  Início
                </a>

                <div className="flex items-center gap-6 py-2">
                  <a
                    href="https://www.instagram.com/lanches.doben/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white hover:text-brand-red transition-colors"
                  >
                    <Instagram size={24} />
                  </a>
                  <a
                    href="https://www.facebook.com/lanches.dobem.2025?mibextid=wwXIfr&rdid=joCIhkS38u0Amnma&share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2F1C8gGroWcL%2F%3Fmibextid%3DwwXIfr%26ref%3D1#"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white hover:text-brand-red transition-colors"
                  >
                    <Facebook size={24} />
                  </a>
                </div>

                <button
                  onClick={() => {
                    setIsMenuOpen(false);
                    openAdminModal();
                  }}
                  className="text-lg font-medium w-full text-left text-white hover:text-brand-red transition-colors flex items-center gap-2"
                >
                  <Lock size={18} />
                  Admin
                </button>

                <button
                  onClick={() => {
                    setIsMenuOpen(false);
                    handleWhatsApp();
                  }}
                  className="w-full bg-brand-red text-white py-3 rounded-xl font-bold flex items-center justify-center gap-2"
                >
                  <ShoppingBag size={20} />
                  Pedir Agora
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Floating Hours Bar */}
      <div className="fixed bottom-6 left-6 z-[60]">
        <button 
          onClick={() => setIsHoursOpen(!isHoursOpen)}
          className="bg-brand-black text-white p-4 rounded-full shadow-2xl border border-white/10 flex items-center gap-3 hover:bg-brand-red transition-all group"
        >
          <Clock size={24} className="group-hover:rotate-12 transition-transform" />
          <span className="font-bold pr-2">Horários</span>
        </button>

        <AnimatePresence>
          {isHoursOpen && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8, y: 20, x: -20 }}
              animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: 20, x: -20 }}
              className="absolute bottom-20 left-0 w-72 bg-white rounded-3xl shadow-2xl border border-gray-100 overflow-hidden"
            >
              <div className="bg-brand-red p-4 text-white text-center">
                <h4 className="font-display text-xl">HORÁRIO DE FUNCIONAMENTO</h4>
              </div>
              <div className="p-6 space-y-3 text-sm">
                <div className="flex justify-between items-center pb-2 border-b border-gray-50">
                  <span className="font-bold">Segunda a Quinta</span>
                  <span className="text-gray-600">18:00 – 01:00</span>
                </div>
                <div className="flex justify-between items-center pb-2 border-b border-gray-50">
                  <span className="font-bold text-brand-red">Sexta a Domingo</span>
                  <span className="text-brand-red font-bold">18:00 – 02:00</span>
                </div>
                <div className="pt-2 text-center text-xs text-gray-400 italic">
                  * Sujeito a alterações em feriados
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Admin Login Modal */}
      <AnimatePresence>
        {isAdminModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center px-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeAdminModal}
              className="absolute inset-0 bg-brand-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-md rounded-3xl overflow-hidden shadow-2xl"
            >
              <div className="bg-brand-red p-8 text-center text-white">
                <div className="bg-white/20 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Lock size={32} />
                </div>
                <h2 className="font-display text-3xl">ÁREA DO ADMIN</h2>
                <p className="text-white/80 text-sm">Acesse para gerenciar sua hamburgueria</p>
              </div>
              <div className="p-8">
                <form className="space-y-6" onSubmit={handleAdminLogin} autoComplete="on">
                  <div>
                    <label className="block text-xs font-bold mb-2 uppercase tracking-widest text-gray-400">Usuário</label>
                    <input 
                      type="email"
                      name="username"
                      value={adminEmail}
                      onChange={(e) => {
                        setAdminEmail(e.target.value);
                        if (adminError) setAdminError('');
                      }}
                      autoComplete="username"
                      required
                      className="w-full bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 focus:ring-2 focus:ring-brand-red outline-none transition-all" 
                      placeholder="meu@admin.com"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold mb-2 uppercase tracking-widest text-gray-400">Senha</label>
                    <div className="relative">
                      <input 
                        type={isAdminPasswordVisible ? 'text' : 'password'}
                        name="password"
                        value={adminPassword}
                        onChange={(e) => {
                          setAdminPassword(e.target.value);
                          if (adminError) setAdminError('');
                        }}
                        autoComplete="current-password"
                        required
                        className="w-full bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 pr-12 focus:ring-2 focus:ring-brand-red outline-none transition-all" 
                        placeholder="••••••••"
                      />
                      <button
                        type="button"
                        onClick={() => setIsAdminPasswordVisible((current) => !current)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-brand-black transition-colors"
                        aria-label={isAdminPasswordVisible ? 'Ocultar senha' : 'Ver senha'}
                      >
                        {isAdminPasswordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </div>
                  <label className="flex items-center gap-3 text-sm text-gray-600 select-none">
                    <input
                      type="checkbox"
                      checked={rememberAdminAccess}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setRememberAdminAccess(next);
                        persistRememberAdminAccess(next);
                        if (!next) {
                          persistSavedAdminEmail('');
                        }
                      }}
                      className="h-4 w-4 accent-brand-red"
                    />
                    Salvar senha e acesso neste navegador
                  </label>
                  <p className="-mt-4 text-xs text-gray-400">
                    Ao entrar, seu navegador pode sugerir salvar a senha automaticamente.
                  </p>
                  {adminError && (
                    <p className="text-sm font-semibold text-red-600 text-center">
                      {adminError}
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={isAdminRedirecting}
                    className="w-full bg-brand-black text-white py-4 rounded-xl font-bold hover:bg-brand-red transition-all shadow-lg disabled:opacity-70 disabled:cursor-not-allowed"
                  >
                    {isAdminRedirecting ? 'Abrindo painel...' : 'Entrar no Painel'}
                  </button>
                  <button 
                    type="button"
                    onClick={closeAdminModal}
                    className="w-full text-gray-400 text-sm font-medium hover:text-brand-black transition-colors"
                  >
                    Voltar ao Site
                  </button>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Hero Section */}
      <section id="home" className="relative h-screen flex items-center justify-center overflow-hidden bg-brand-black pt-20">
        <div className="absolute inset-0 z-0">
          <img 
            src="https://i.pinimg.com/736x/6b/f7/46/6bf7465d1a625ccc5c1e6d27e92e4936.jpg" 
            alt="Hero Background" 
            className="w-full h-full object-cover opacity-40"
            loading="eager"
            decoding="async"
            fetchPriority="high"
            referrerPolicy="no-referrer"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-brand-black via-transparent to-brand-black/50" />
        </div>

        <div className="relative z-10 max-w-7xl mx-auto px-4 text-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            
            <h2 className="text-brand-red font-display text-2xl md:text-3xl mb-4 tracking-widest uppercase">O Melhor do Rio de Janeiro</h2>
            <motion.h1
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
              animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              transition={
                prefersReducedMotion
                  ? { duration: 0.45, delay: 0.2 }
                  : { duration: 0.75, delay: 0.2, ease: [0.22, 1, 0.36, 1] }
              }
              className="text-white font-display text-6xl md:text-9xl mb-8 leading-none tracking-tighter"
            >
              <motion.span
                initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: 18, letterSpacing: '0.12em' }}
                animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, letterSpacing: '0.02em' }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0 }
                    : { duration: 0.65, delay: 0.35, ease: [0.22, 1, 0.36, 1] }
                }
                className="block"
              >
                SABOR QUE
              </motion.span>
              <motion.span
                initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.88 }}
                animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0 }
                    : { duration: 0.7, delay: 0.5, ease: [0.22, 1, 0.36, 1] }
                }
                className="block hero-special-headline"
              >
                SURPREENDE
              </motion.span>
            </motion.h1>
            <p className="text-white/80 text-lg md:text-xl max-w-2xl mx-auto mb-10 font-light">
              Lanchonete e Hambúrgueria feitos com blends exclusivos, ingredientes frescos e aquele toque especial do Ben.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <motion.button
                initial={false}
                animate={
                  playHeroCtaIntro
                    ? { opacity: 1, scale: [0.88, 1.08, 0.98, 1] }
                    : { opacity: 1, scale: 1 }
                }
                transition={
                  playHeroCtaIntro
                    ? {
                        duration: 0.9,
                        delay: 0.2,
                        times: [0, 0.55, 0.82, 1],
                        ease: [0.22, 1, 0.36, 1],
                      }
                    : { duration: 0.2 }
                }
                onAnimationComplete={() => setPlayHeroCtaIntro(false)}
                onClick={handleWhatsApp}
                className="w-full sm:w-auto bg-brand-red hover:bg-red-700 text-white px-12 py-5 rounded-full font-bold text-xl transition-all transform hover:scale-105 shadow-2xl shadow-brand-red/40"
              >
                Pedir Agora
              </motion.button>
            </div>

          </motion.div>
        </div>

        {/* Floating elements for visual interest */}
        <motion.div 
          animate={{ y: [0, -20, 0] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          className="absolute bottom-20 left-10 hidden lg:block"
        >
          <div className="bg-white/5 backdrop-blur-md border border-white/10 p-4 rounded-2xl">
            <div className="flex items-center gap-3">
              <div className="bg-brand-red p-2 rounded-lg">
                <Star className="text-white fill-white" size={20} />
              </div>
              <div>
                <p className="text-white font-bold text-sm">4.9/5 Estrelas</p>
                <p className="text-white/60 text-xs">No Google Reviews</p>
              </div>
            </div>
          </div>
        </motion.div>
      </section>

      {/* Products Section */}
      <section className="relative py-20 bg-gradient-to-b from-brand-black to-slate-950 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-brand-red/20 blur-3xl" />
          <div className="absolute bottom-0 right-0 h-56 w-56 rounded-full bg-red-900/20 blur-3xl" />
        </div>
        <div className="relative z-10 max-w-7xl mx-auto px-4">
          <div className="max-w-6xl mx-auto">
            <div className="inline-flex items-center rounded-t-2xl border border-b-0 border-white/20 bg-brand-red px-5 py-2 shadow-lg shadow-brand-red/30">
              <p className="text-white text-xs md:text-sm font-black tracking-[0.16em] uppercase">
                Aba de Produtos do Caixa
              </p>
            </div>
            <div className="rounded-3xl rounded-tl-none border border-white/20 bg-brand-black/70 md:bg-brand-black/55 p-4 md:p-6">
              {isProductsLoading ? (
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
                  {Array.from({ length: 6 }).map((_, index) => (
                    <div
                      key={`product-skeleton-${index}`}
                      className="h-56 rounded-2xl bg-white/10 animate-pulse border border-white/10"
                    />
                  ))}
                </div>
              ) : publicProducts.length > 0 ? (
                <>
                  {productsError && (
                    <p className="mb-4 text-amber-300 text-sm font-semibold">{productsError}</p>
                  )}
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5 text-left">
                    {publicProducts.map((product) => (
                      <article
                        key={product.id}
                        className="group rounded-2xl overflow-hidden bg-white/95 border border-white/20 shadow-xl shadow-brand-black/30"
                      >
                        <div className="relative h-36 overflow-hidden bg-slate-100">
                          {product.imageUrl ? (
                            <img
                              src={product.imageUrl}
                              alt={`Produto ${product.name}`}
                              className="w-full h-full object-cover"
                              loading="eager"
                              decoding="async"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-white/80 text-sm font-semibold">
                              Sem imagem
                            </div>
                          )}
                          <span className="absolute top-3 left-3 bg-brand-black/80 text-white text-[10px] tracking-wider uppercase px-2.5 py-1 rounded-full border border-white/20">
                            {resolveProductCategoryLabel(product.category)}
                          </span>
                        </div>
                        <div className="p-4">
                          <h3 className="text-lg font-black leading-tight text-brand-black">
                            {product.name}
                          </h3>
                          <p className="mt-2 text-brand-red font-black text-xl">
                            {BRL_CURRENCY_FORMATTER.format(product.price)}
                          </p>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-white/80">
                  {productsError || 'Nenhum produto cadastrado no sistema no momento.'}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Contact Section */}
      <section id="contact" className="py-24 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4">
          <div className="max-w-2xl mx-auto text-center">
            <h2 className="text-brand-red font-display text-2xl mb-4">Contato</h2>
            <h3 className="font-display text-5xl mb-12">VEM PRO BEN!</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
              <a 
                href="https://maps.app.goo.gl/NsRzHNobQ5ApwU7G7" 
                target="_blank" 
                rel="noopener noreferrer"
                className="flex flex-col items-center gap-4 p-6 bg-white rounded-3xl shadow-sm border border-gray-100 hover:border-brand-red transition-all group"
              >
                <div className="bg-gray-50 p-4 rounded-2xl group-hover:bg-brand-red/10 transition-colors">
                  <MapPin className="text-brand-red" size={32} />
                </div>
                <div>
                  <p className="font-bold text-lg">Endereço</p>
                  <p className="text-gray-600">Clique para abrir o Mapa</p>
                </div>
              </a>
              <a 
                href="tel:+5521983659826"
                className="flex flex-col items-center gap-4 p-6 bg-white rounded-3xl shadow-sm border border-gray-100 hover:border-brand-red transition-all group"
              >
                <div className="bg-gray-50 p-4 rounded-2xl group-hover:bg-brand-red/10 transition-colors">
                  <Phone className="text-brand-red" size={32} />
                </div>
                <div>
                  <p className="font-bold text-lg">Telefone</p>
                  <p className="text-gray-600">(21) 98365-9826</p>
                </div>
              </a>
              <button 
                onClick={() => setIsHoursOpen(true)}
                className="flex flex-col items-center gap-4 p-6 bg-white rounded-3xl shadow-sm border border-gray-100 hover:border-brand-red transition-all group"
              >
                <div className="bg-gray-50 p-4 rounded-2xl group-hover:bg-brand-red/10 transition-colors">
                  <Clock className="text-brand-red" size={32} />
                </div>
                <div>
                  <p className="font-bold text-lg">Horário</p>
                  <p className="text-gray-600">Ver Funcionamento</p>
                </div>
              </button>
            </div>

            <div className="flex justify-center gap-6">
              <a 
                href="https://www.instagram.com/lanches.doben/" 
                target="_blank" 
                rel="noopener noreferrer"
                className="bg-brand-black text-white p-4 rounded-full hover:bg-brand-red transition-all transform hover:scale-110 shadow-lg"
              >
                <Instagram size={28} />
              </a>
              <a 
                href="https://www.facebook.com/lanches.dobem.2025?mibextid=wwXIfr&rdid=joCIhkS38u0Amnma&share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2F1C8gGroWcL%2F%3Fmibextid%3DwwXIfr%26ref%3D1#" 
                target="_blank" 
                rel="noopener noreferrer"
                className="bg-brand-black text-white p-4 rounded-full hover:bg-brand-red transition-all transform hover:scale-110 shadow-lg"
              >
                <Facebook size={28} />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-brand-black text-white py-12 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <img 
            src="https://i.pinimg.com/736x/69/40/d9/6940d97853972edd36dd7e77a4a99bc9.jpg" 
            alt="Logo Footer" 
            className="w-20 h-20 rounded-full mx-auto mb-4 border-2 border-brand-red object-cover"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
          <span className="font-display text-4xl tracking-tighter text-brand-red mb-6 block">LANCHESDOBEN</span>
          <p className="text-white/40 text-sm mb-8">
            © {new Date().getFullYear()} LANCHESDOBEN.COM.BR Todos os direitos reservados.
          </p>
          <div className="flex justify-center gap-8 text-white/60 text-sm">
            <a href="#" className="hover:text-white transition-colors">Privacidade</a>
            <a href="#" className="hover:text-white transition-colors">Termos de Uso</a>
            <a href="#" className="hover:text-white transition-colors">Cookies</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  if (isErrorMonitorRoute()) {
    return <ErrorMonitorPortal />;
  }
  if (isDeveloperRoute()) {
    return <DeveloperPortal />;
  }
  return <MainSiteApp />;
}
