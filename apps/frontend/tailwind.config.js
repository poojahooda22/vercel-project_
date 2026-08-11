import tailwindcssAnimate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
	content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
	darkMode: ['selector', '[data-theme="dark"]', 'class'],
	theme: {
		extend: {
			fontFamily: {
				sans: [
					'"DM Sans"',
					'Inter',
					'system-ui',
					'sans-serif'
				],
				mono: [
					'"DM Mono"',
					'ui-monospace',
					'SFMono-Regular',
					'monospace'
				],
				display: [
					'Harmond',
					'sans-serif'
				],
			},
			colors: {
				/* ── Backgrounds ──────────────────────────────────────
				   CSS: --rare-bg-*  →  TW group: background
				   Class: bg-background, bg-background-secondary, etc.
				   ──────────────────────────────────────────────────── */
				background: {
					DEFAULT: 'var(--rare-bg)',
					alt: 'var(--rare-bg-alt)',
					hover: 'var(--rare-bg-hover)',
					solid: 'var(--rare-bg-solid)',
					secondary: 'var(--rare-bg-secondary)',
					'secondary-alt': 'var(--rare-bg-secondary-alt)',
					'secondary-hover': 'var(--rare-bg-secondary-hover)',
					'secondary-subtle': 'var(--rare-bg-secondary-subtle)',
					'secondary-solid': 'var(--rare-bg-secondary-solid)',
					tertiary: 'var(--rare-bg-tertiary)',
					quaternary: 'var(--rare-bg-quaternary)',
					active: 'var(--rare-bg-active)',
					'active-hover': 'var(--rare-bg-active-hover)',
					disabled: 'var(--rare-bg-disabled)',
					'disabled-subtle': 'var(--rare-bg-disabled-subtle)',
					overlay: 'var(--rare-bg-overlay)',
					brand: 'var(--rare-bg-brand)',
					'brand-alt': 'var(--rare-bg-brand-alt)',
					'brand-secondary': 'var(--rare-bg-brand-secondary)',
					'brand-secondary-alt': 'var(--rare-bg-brand-secondary-alt)',
					'brand-solid': 'var(--rare-bg-brand-solid)',
					'brand-solid-hover': 'var(--rare-bg-brand-solid-hover)',
					'brand-section': 'var(--rare-bg-brand-section)',
					'brand-section-subtle': 'var(--rare-bg-brand-section-subtle)',
					error: 'var(--rare-bg-error)',
					'error-secondary': 'var(--rare-bg-error-secondary)',
					'error-solid': 'var(--rare-bg-error-solid)',
					'error-solid-hover': 'var(--rare-bg-error-solid-hover)',
					warning: 'var(--rare-bg-warning)',
					'warning-secondary': 'var(--rare-bg-warning-secondary)',
					'warning-solid': 'var(--rare-bg-warning-solid)',
					'warning-solid-hover': 'var(--rare-bg-warning-solid-hover)',
					success: 'var(--rare-bg-success)',
					'success-secondary': 'var(--rare-bg-success-secondary)',
					'success-solid': 'var(--rare-bg-success-solid)',
					'success-solid-hover': 'var(--rare-bg-success-solid-hover)',
				},

				/* ── Text (typography) ────────────────────────────────
				   CSS: --rare-text-*  →  TW group: foreground
				   Class: text-foreground, text-foreground-secondary, etc.
				   ──────────────────────────────────────────────────── */
				foreground: {
					DEFAULT: 'var(--rare-text)',
					'on-brand': 'var(--rare-text-on-brand)',
					secondary: 'var(--rare-text-secondary)',
					'secondary-on-brand': 'var(--rare-text-secondary-on-brand)',
					tertiary: 'var(--rare-text-tertiary)',
					'tertiary-on-brand': 'var(--rare-text-tertiary-on-brand)',
					muted: 'var(--rare-text-muted)',
					'muted-on-brand': 'var(--rare-text-muted-on-brand)',
					white: 'var(--rare-text-white)',
					disabled: 'var(--rare-text-disabled)',
					'disabled-subtle': 'var(--rare-text-disabled-subtle)',
					placeholder: 'var(--rare-text-placeholder)',
					'placeholder-subtle': 'var(--rare-text-placeholder-subtle)',
					brand: 'var(--rare-text-brand)',
					'brand-dark': 'var(--rare-text-brand-dark)',
					'brand-secondary': 'var(--rare-text-brand-secondary)',
					'brand-tertiary': 'var(--rare-text-brand-tertiary)',
					'brand-tertiary-alt': 'var(--rare-text-brand-tertiary-alt)',
					error: 'var(--rare-text-error)',
					'error-dark': 'var(--rare-text-error-dark)',
					warning: 'var(--rare-text-warning)',
					'warning-dark': 'var(--rare-text-warning-dark)',
					success: 'var(--rare-text-success)',
					'success-dark': 'var(--rare-text-success-dark)',
				},

				/* ── Icon / Decorative FG ─────────────────────────────
				   CSS: --rare-fg-*  →  TW group: fg
				   Class: text-fg, text-fg-secondary, bg-fg-brand, etc.
				   ──────────────────────────────────────────────────── */
				fg: {
					DEFAULT: 'var(--rare-fg)',
					secondary: 'var(--rare-fg-secondary)',
					tertiary: 'var(--rare-fg-tertiary)',
					muted: 'var(--rare-fg-muted)',
					subtle: 'var(--rare-fg-subtle)',
					faint: 'var(--rare-fg-faint)',
					white: 'var(--rare-fg-white)',
					disabled: 'var(--rare-fg-disabled)',
					'disabled-subtle': 'var(--rare-fg-disabled-subtle)',
					brand: 'var(--rare-fg-brand)',
					'brand-alt': 'var(--rare-fg-brand-alt)',
					'brand-secondary': 'var(--rare-fg-brand-secondary)',
					error: 'var(--rare-fg-error)',
					'error-secondary': 'var(--rare-fg-error-secondary)',
					warning: 'var(--rare-fg-warning)',
					'warning-secondary': 'var(--rare-fg-warning-secondary)',
					success: 'var(--rare-fg-success)',
					'success-secondary': 'var(--rare-fg-success-secondary)',
				},

				/* ── Border colors (also in borderColor below) ───────
				   Kept in `colors` so bg-border-* works for dividers,
				   tracks, separators. For actual border-color utilities,
				   use borderColor config which produces clean classes:
				   border-secondary, border-brand, etc. (no doubling)
				   ──────────────────────────────────────────────────── */
				border: {
					DEFAULT: 'var(--rare-border)',
					secondary: 'var(--rare-border-secondary)',
					tertiary: 'var(--rare-border-tertiary)',
					disabled: 'var(--rare-border-disabled)',
					'disabled-subtle': 'var(--rare-border-disabled-subtle)',
					brand: 'var(--rare-border-brand)',
					'brand-solid': 'var(--rare-border-brand-solid)',
					'brand-solid-alt': 'var(--rare-border-brand-solid-alt)',
					error: 'var(--rare-border-error)',
					'error-solid': 'var(--rare-border-error-solid)',
					warning: 'var(--rare-border-warning)',
					'warning-solid': 'var(--rare-border-warning-solid)',
					success: 'var(--rare-border-success)',
					'success-solid': 'var(--rare-border-success-solid)',
				},

				/* ── Primitive Scales (not themed) ────────────────── */
				brand: {
					'25': 'var(--rare-brand-25)',
					'50': 'var(--rare-brand-50)',
					'100': 'var(--rare-brand-100)',
					'200': 'var(--rare-brand-200)',
					'300': 'var(--rare-brand-300)',
					'400': 'var(--rare-brand-400)',
					'500': 'var(--rare-brand-500)',
					'600': 'var(--rare-brand-600)',
					'700': 'var(--rare-brand-700)',
					'800': 'var(--rare-brand-800)',
					'900': 'var(--rare-brand-900)',
					'950': 'var(--rare-brand-950)'
				},
				error: {
					'25': 'var(--rare-error-25)',
					'50': 'var(--rare-error-50)',
					'100': 'var(--rare-error-100)',
					'200': 'var(--rare-error-200)',
					'300': 'var(--rare-error-300)',
					'400': 'var(--rare-error-400)',
					'500': 'var(--rare-error-500)',
					'600': 'var(--rare-error-600)',
					'700': 'var(--rare-error-700)',
					'800': 'var(--rare-error-800)',
					'900': 'var(--rare-error-900)',
					'950': 'var(--rare-error-950)'
				},
				warning: {
					'25': 'var(--rare-warning-25)',
					'50': 'var(--rare-warning-50)',
					'100': 'var(--rare-warning-100)',
					'200': 'var(--rare-warning-200)',
					'300': 'var(--rare-warning-300)',
					'400': 'var(--rare-warning-400)',
					'500': 'var(--rare-warning-500)',
					'600': 'var(--rare-warning-600)',
					'700': 'var(--rare-warning-700)',
					'800': 'var(--rare-warning-800)',
					'900': 'var(--rare-warning-900)',
					'950': 'var(--rare-warning-950)'
				},
				success: {
					'25': 'var(--rare-success-25)',
					'50': 'var(--rare-success-50)',
					'100': 'var(--rare-success-100)',
					'200': 'var(--rare-success-200)',
					'300': 'var(--rare-success-300)',
					'400': 'var(--rare-success-400)',
					'500': 'var(--rare-success-500)',
					'600': 'var(--rare-success-600)',
					'700': 'var(--rare-success-700)',
					'800': 'var(--rare-success-800)',
					'900': 'var(--rare-success-900)',
					'950': 'var(--rare-success-950)'
				},

				/* ── Component: Buttons ───────────────────────────── */
				'btn-primary': {
					bg: 'var(--rare-btn-primary-bg)',
					border: 'var(--rare-btn-primary-border)',
					fg: 'var(--rare-btn-primary-fg)',
					'bg-hover': 'var(--rare-btn-primary-bg-hover)',
					'border-hover': 'var(--rare-btn-primary-border-hover)',
					'fg-hover': 'var(--rare-btn-primary-fg-hover)'
				},
				'btn-secondary': {
					bg: 'var(--rare-btn-secondary-bg)',
					border: 'var(--rare-btn-secondary-border)',
					fg: 'var(--rare-btn-secondary-fg)',
					'bg-hover': 'var(--rare-btn-secondary-bg-hover)',
					'border-hover': 'var(--rare-btn-secondary-border-hover)',
					'fg-hover': 'var(--rare-btn-secondary-fg-hover)'
				},
				'btn-secondary-color': {
					bg: 'var(--rare-btn-secondary-color-bg)',
					border: 'var(--rare-btn-secondary-color-border)',
					fg: 'var(--rare-btn-secondary-color-fg)',
					'bg-hover': 'var(--rare-btn-secondary-color-bg-hover)',
					'border-hover': 'var(--rare-btn-secondary-color-border-hover)',
					'fg-hover': 'var(--rare-btn-secondary-color-fg-hover)'
				},
				'btn-tertiary': {
					fg: 'var(--rare-btn-tertiary-fg)',
					'bg-hover': 'var(--rare-btn-tertiary-bg-hover)',
					'fg-hover': 'var(--rare-btn-tertiary-fg-hover)'
				},
				'btn-tertiary-color': {
					fg: 'var(--rare-btn-tertiary-color-fg)',
					'bg-hover': 'var(--rare-btn-tertiary-color-bg-hover)',
					'fg-hover': 'var(--rare-btn-tertiary-color-fg-hover)'
				},

				/* ── Component: Alert / Toast colored cards ──────── */
			alert: {
				brand: 'var(--rare-alert-brand-bg)',
				error: 'var(--rare-alert-error-bg)',
				warning: 'var(--rare-alert-warning-bg)',
				success: 'var(--rare-alert-success-bg)',
			},

			/* ── Component: Tabs + Charts ─────────────────────── */
				'tab-active-bg': 'var(--rare-tab-active-bg)',
				'chart-bg': {
					'1': 'var(--rare-chart-bg-1)',
					'2': 'var(--rare-chart-bg-2)',
					'3': 'var(--rare-chart-bg-3)',
					'4': 'var(--rare-chart-bg-4)',
				},
			},
			/* ── Border color utilities (clean: border-secondary) ── */
			borderColor: {
				DEFAULT: 'var(--rare-border)',
				primary: 'var(--rare-border)',
				secondary: 'var(--rare-border-secondary)',
				tertiary: 'var(--rare-border-tertiary)',
				disabled: 'var(--rare-border-disabled)',
				'disabled-subtle': 'var(--rare-border-disabled-subtle)',
				brand: 'var(--rare-border-brand)',
				'brand-solid': 'var(--rare-border-brand-solid)',
				'brand-solid-alt': 'var(--rare-border-brand-solid-alt)',
				error: 'var(--rare-border-error)',
				'error-solid': 'var(--rare-border-error-solid)',
				warning: 'var(--rare-border-warning)',
				'warning-solid': 'var(--rare-border-warning-solid)',
				success: 'var(--rare-border-success)',
				'success-solid': 'var(--rare-border-success-solid)',
				/* Alert / Toast colored cards */
				'alert-brand': 'var(--rare-alert-brand-border)',
				'alert-error': 'var(--rare-alert-error-border)',
				'alert-warning': 'var(--rare-alert-warning-border)',
				'alert-success': 'var(--rare-alert-success-border)',
			},
			spacing: {
				xxs: 'var(--rare-spacing-xxs, 2px)',
				xs: 'var(--rare-spacing-xs, 4px)',
				sm: 'var(--rare-spacing-sm, 6px)',
				md: 'var(--rare-spacing-md, 8px)',
				lg: 'var(--rare-spacing-lg, 10px)',
				xl: 'var(--rare-spacing-xl, 12px)',
				'2xl': 'var(--rare-spacing-2xl, 16px)',
				'3xl': 'var(--rare-spacing-3xl, 20px)',
				'4xl': 'var(--rare-spacing-4xl, 24px)',
				'5xl': 'var(--rare-spacing-5xl, 32px)',
				'6xl': 'var(--rare-spacing-6xl, 36px)',
				'7xl': 'var(--rare-spacing-7xl, 40px)',
				'8xl': 'var(--rare-spacing-8xl, 48px)',
				'9xl': 'var(--rare-spacing-9xl, 52px)',
				'10xl': 'var(--rare-spacing-10xl, 60px)',
				'11xl': 'var(--rare-spacing-11xl, 64px)',
				'12xl': 'var(--rare-spacing-12xl, 80px)',
				'13xl': 'var(--rare-spacing-13xl, 96px)',
				'14xl': 'var(--rare-spacing-14xl, 128px)',
				'15xl': 'var(--rare-spacing-15xl, 160px)'
			},
			width: {
				'width-3xs': 'var(--rare-width-3xs, 256px)',
				'width-2xs': 'var(--rare-width-2xs, 320px)',
				'width-xs': 'var(--rare-width-xs, 384px)',
				'width-sm': 'var(--rare-width-sm, 480px)',
				'width-md': 'var(--rare-width-md, 560px)',
				'width-lg': 'var(--rare-width-lg, 640px)',
				'width-xl': 'var(--rare-width-xl, 768px)',
				'width-2xl': 'var(--rare-width-2xl, 1024px)',
				'width-3xl': 'var(--rare-width-3xl, 1280px)',
				'width-4xl': 'var(--rare-width-4xl, 1440px)',
				'width-5xl': 'var(--rare-width-5xl, 1600px)',
				'width-6xl': 'var(--rare-width-6xl, 1920px)',
			},
			maxWidth: {
				'width-3xs': 'var(--rare-width-3xs, 256px)',
				'width-2xs': 'var(--rare-width-2xs, 320px)',
				'width-xs': 'var(--rare-width-xs, 384px)',
				'width-sm': 'var(--rare-width-sm, 480px)',
				'width-md': 'var(--rare-width-md, 560px)',
				'width-lg': 'var(--rare-width-lg, 640px)',
				'width-xl': 'var(--rare-width-xl, 768px)',
				'width-2xl': 'var(--rare-width-2xl, 1024px)',
				'width-3xl': 'var(--rare-width-3xl, 1280px)',
				'width-4xl': 'var(--rare-width-4xl, 1440px)',
				'width-5xl': 'var(--rare-width-5xl, 1600px)',
				'width-6xl': 'var(--rare-width-6xl, 1920px)',
			},
			height: {
				'width-3xs': 'var(--rare-width-3xs, 256px)',
				'width-2xs': 'var(--rare-width-2xs, 320px)',
				'width-xs': 'var(--rare-width-xs, 384px)',
				'width-sm': 'var(--rare-width-sm, 480px)',
				'width-md': 'var(--rare-width-md, 560px)',
				'width-lg': 'var(--rare-width-lg, 640px)',
				'width-xl': 'var(--rare-width-xl, 768px)',
				'width-2xl': 'var(--rare-width-2xl, 1024px)',
				'width-3xl': 'var(--rare-width-3xl, 1280px)',
				'width-4xl': 'var(--rare-width-4xl, 1440px)',
				'width-5xl': 'var(--rare-width-5xl, 1600px)',
				'width-6xl': 'var(--rare-width-6xl, 1920px)',
			},
			borderRadius: {
				none: 'var(--rare-radius-none, 0px)',
				xxs: 'var(--rare-radius-xxs, 2px)',
				xs: 'var(--rare-radius-xs, 4px)',
				sm: 'var(--rare-radius-sm, 6px)',
				md: 'var(--rare-radius-md, 8px)',
				lg: 'var(--rare-radius-lg, 10px)',
				xl: 'var(--rare-radius-xl, 12px)',
				'2xl': 'var(--rare-radius-2xl, 16px)',
				'3xl': 'var(--rare-radius-3xl, 20px)',
				'4xl': 'var(--rare-radius-4xl, 24px)',
				full: 'var(--rare-radius-full, 9999px)'
			},
			fontSize: {
				/* Text group — maps to standard Tailwind size names */
				'xxs': ['var(--rare-font-text-xxs, 10px)', { lineHeight: 'var(--rare-line-height-text-xxs, 15px)' }],
				'xs': ['var(--rare-font-text-xs, 12px)', { lineHeight: 'var(--rare-line-height-text-xs, 18px)' }],
				'sm': ['var(--rare-font-text-sm, 14px)', { lineHeight: 'var(--rare-line-height-text-sm, 20px)' }],
				'base': ['var(--rare-font-text-md, 16px)', { lineHeight: 'var(--rare-line-height-text-md, 24px)' }],
				'lg': ['var(--rare-font-text-lg, 18px)', { lineHeight: 'var(--rare-line-height-text-lg, 28px)' }],
				'xl': ['var(--rare-font-text-xl, 20px)', { lineHeight: 'var(--rare-line-height-text-xl, 30px)' }],
				/* Display group — prefixed to avoid collision */
				'display-xs': ['var(--rare-font-display-xs, 24px)', { lineHeight: 'var(--rare-line-height-display-xs, 32px)' }],
				'display-sm': ['var(--rare-font-display-sm, 30px)', { lineHeight: 'var(--rare-line-height-display-sm, 38px)' }],
				'display-md': ['var(--rare-font-display-md, 36px)', { lineHeight: 'var(--rare-line-height-display-md, 44px)', letterSpacing: 'var(--rare-tracking-display-md, -0.72px)' }],
				'display-lg': ['var(--rare-font-display-lg, 48px)', { lineHeight: 'var(--rare-line-height-display-lg, 60px)', letterSpacing: 'var(--rare-tracking-display-lg, -0.96px)' }],
				'display-xl': ['var(--rare-font-display-xl, 60px)', { lineHeight: 'var(--rare-line-height-display-xl, 72px)', letterSpacing: 'var(--rare-tracking-display-xl, -1.2px)' }],
				'display-2xl': ['var(--rare-font-display-2xl, 72px)', { lineHeight: 'var(--rare-line-height-display-2xl, 90px)', letterSpacing: 'var(--rare-tracking-display-2xl, -1.44px)' }],
			},
			/* ═══ Elevation — Shadow + Focus ═══════════════════════════ */
			boxShadow: {
				/* Shadow (7 tiers) */
				xs: 'var(--rare-shadow-xs)',
				sm: 'var(--rare-shadow-sm)',
				md: 'var(--rare-shadow-md)',
				lg: 'var(--rare-shadow-lg)',
				xl: 'var(--rare-shadow-xl)',
				'2xl': 'var(--rare-shadow-2xl)',
				'3xl': 'var(--rare-shadow-3xl)',
				/* Focus (2px indicator, no elevation) */
				'focus-ring-brand': 'var(--rare-focus-ring-brand)',
				'focus-ring-gray': 'var(--rare-focus-ring-gray)',
				'focus-ring-gray-secondary': 'var(--rare-focus-ring-gray-secondary)',
				'focus-ring-error': 'var(--rare-focus-ring-error)',
				/* Focus + Shadow (indicator + elevation composite) */
				'focus-ring-brand-xs': 'var(--rare-focus-ring-brand), var(--rare-shadow-xs)',
				'focus-ring-brand-sm': 'var(--rare-focus-ring-brand), var(--rare-shadow-sm)',
				'focus-ring-gray-xs': 'var(--rare-focus-ring-gray), var(--rare-shadow-xs)',
				'focus-ring-gray-sm': 'var(--rare-focus-ring-gray), var(--rare-shadow-sm)',
				'focus-ring-error-xs': 'var(--rare-focus-ring-error), var(--rare-shadow-xs)'
			},
			/* ═══ Animation Timing Tokens ══════════════════════════════ */
			transitionDuration: {
				fast: 'var(--rare-duration-fast, 150ms)',
				normal: 'var(--rare-duration-normal, 300ms)',
				slow: 'var(--rare-duration-slow, 500ms)',
				slower: 'var(--rare-duration-slower, 700ms)',
			},
			transitionTimingFunction: {
				'ease-out-emphasized': 'var(--rare-easing-ease-out, cubic-bezier(0.16, 1, 0.3, 1))',
				'ease-in-out-smooth': 'var(--rare-easing-ease-in-out, cubic-bezier(0.65, 0, 0.35, 1))',
				spring: 'var(--rare-easing-spring, cubic-bezier(0.34, 1.56, 0.64, 1))',
			},
			keyframes: {
				'accordion-down': {
					from: { height: '0' },
					to: { height: 'var(--radix-accordion-content-height)' }
				},
				'accordion-up': {
					from: { height: 'var(--radix-accordion-content-height)' },
					to: { height: '0' }
				},
				'rare-gradient-orbit': {
					'0%, 100%': { transform: 'rotate(0deg) scale(1)' },
					'25%': { transform: 'rotate(90deg) scale(1.1)' },
					'50%': { transform: 'rotate(180deg) scale(1)' },
					'75%': { transform: 'rotate(270deg) scale(1.1)' },
				},
				'rare-cardbeam-glitch': {
					'0%':   { opacity: '1' },
					'15%':  { opacity: '0.9' },
					'16%':  { opacity: '1' },
					'49%':  { opacity: '0.8' },
					'50%':  { opacity: '1' },
					'99%':  { opacity: '0.9' },
					'100%': { opacity: '1' },
				},
			/* ── Phase 1 Component Motion ─────────────────────── */
			'rare-shimmer': {
				'0%':   { backgroundPosition: '-200% 0' },
				'100%': { backgroundPosition: '200% 0' },
			},
			'rare-error-shake': {
				'0%, 100%': { transform: 'translateX(0)' },
				'20%':      { transform: 'translateX(-3px)' },
				'40%':      { transform: 'translateX(3px)' },
				'60%':      { transform: 'translateX(-2px)' },
				'80%':      { transform: 'translateX(2px)' },
			},
			'rare-badge-pulse': {
				'0%, 100%': { transform: 'scale(1)', opacity: '1' },
				'50%':      { transform: 'scale(1.05)', opacity: '0.9' },
			},
			/* ── Phase 3 Overlay Motion ──────────────────────── */
			'rare-dropdown-grow': {
				from: { opacity: '0', transform: 'scaleY(0.92) translateY(-4px)' },
				to:   { opacity: '1', transform: 'scaleY(1) translateY(0)' },
			},
			'rare-modal-overshoot': {
				'0%':   { opacity: '0', transform: 'translate(-50%, -50%) scale(1.03)' },
				'100%': { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
			},
			'rare-overshoot': {
				'0%':   { opacity: '0', transform: 'scale(1.03)' },
				'100%': { opacity: '1', transform: 'scale(1)' },
			},
			},
			animation: {
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out',
				'gradient-orbit': 'rare-gradient-orbit 20s ease-in-out infinite',
				'marquee': 'marquee 26s linear infinite',
				'cardbeam-glitch': 'rare-cardbeam-glitch 0.1s infinite linear alternate-reverse',
				/* ── Phase 1 Component Motion ─────────────────────── */
				'shimmer': 'rare-shimmer 2s ease-in-out infinite',
				'error-shake': 'rare-error-shake 0.3s ease-out',
				'badge-pulse': 'rare-badge-pulse 2s ease-in-out infinite',
				/* ── Phase 3 Overlay Motion ──────────────────────── */
				'dropdown-grow': 'rare-dropdown-grow 280ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
				'modal-overshoot': 'rare-modal-overshoot 400ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
				'overshoot': 'rare-overshoot 400ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
			}
		}
	},
	plugins: [tailwindcssAnimate],
};
