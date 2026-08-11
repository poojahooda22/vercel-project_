import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type BadgeVariant = 'pill' | 'badge' | 'modern';
export type BadgeSize = 'sm' | 'md' | 'lg';
export type BadgeColor =
    | 'gray' | 'brand' | 'error' | 'warning' | 'success'
    | 'blueLight' | 'blue' | 'indigo'
    | 'purple' | 'pink' | 'orange';

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
    asChild?: boolean;
    /** @default 'pill' */
    variant?: BadgeVariant;
    /** @default 'md' */
    size?: BadgeSize;
    /** No effect when variant is 'modern'. @default 'gray' */
    color?: BadgeColor;
    /** Only renders on 'modern' variant. @default true (modern), false (pill/badge) */
    dot?: boolean;
    /** Notification pulse animation. @default false */
    pulse?: boolean;
    icon?: React.ReactNode;
    trailingIcon?: React.ReactNode;
    onIconClick?: () => void;
    onTrailingIconClick?: () => void;
    onDismiss?: () => void;
    className?: string;
    children?: React.ReactNode;
}

const dotColorClass: Record<BadgeColor, string> = {
    gray:     'bg-[var(--rare-gray-iron-500)]',
    brand:    'bg-[var(--rare-brand-500)]',
    error:    'bg-[var(--rare-error-500)]',
    warning:  'bg-[var(--rare-warning-500)]',
    success:  'bg-[var(--rare-success-500)]',
    blueLight:'bg-[var(--rare-blue-light-500)]',
    blue:     'bg-[var(--rare-blue-500)]',
    indigo:   'bg-[var(--rare-indigo-500)]',
    purple:   'bg-[var(--rare-purple-500)]',
    pink:     'bg-[var(--rare-pink-500)]',
    orange:   'bg-[var(--rare-orange-500)]',
};

const sizeClasses: Record<BadgeSize, string> = {
    sm: 'py-xs px-sm text-xs leading-none gap-xs',
    md: 'py-xs px-md text-sm leading-none gap-sm',
    lg: 'py-sm px-lg text-sm leading-none gap-md',
};

const colorStyles: Record<BadgeColor, { light: React.CSSProperties; dark: React.CSSProperties }> = {
    gray: {
        light: { backgroundColor: 'var(--rare-gray-iron-50)', borderColor: 'var(--rare-gray-iron-200)', color: 'var(--rare-gray-iron-700)' },
        dark: { backgroundColor: 'var(--rare-gray-iron-950)', borderColor: 'var(--rare-gray-iron-800)', color: 'var(--rare-gray-iron-200)' },
    },
    brand: {
        light: { backgroundColor: 'var(--rare-brand-50)', borderColor: 'var(--rare-brand-200)', color: 'var(--rare-brand-700)' },
        dark: { backgroundColor: 'var(--rare-brand-950)', borderColor: 'var(--rare-brand-800)', color: 'var(--rare-brand-200)' },
    },
    error: {
        light: { backgroundColor: 'var(--rare-error-50)', borderColor: 'var(--rare-error-200)', color: 'var(--rare-error-700)' },
        dark: { backgroundColor: 'var(--rare-error-950)', borderColor: 'var(--rare-error-800)', color: 'var(--rare-error-200)' },
    },
    warning: {
        light: { backgroundColor: 'var(--rare-warning-50)', borderColor: 'var(--rare-warning-200)', color: 'var(--rare-warning-700)' },
        dark: { backgroundColor: 'var(--rare-warning-950)', borderColor: 'var(--rare-warning-800)', color: 'var(--rare-warning-200)' },
    },
    success: {
        light: { backgroundColor: 'var(--rare-success-50)', borderColor: 'var(--rare-success-200)', color: 'var(--rare-success-700)' },
        dark: { backgroundColor: 'var(--rare-success-950)', borderColor: 'var(--rare-success-800)', color: 'var(--rare-success-200)' },
    },
    blueLight: {
        light: { backgroundColor: 'var(--rare-blue-light-50)', borderColor: 'var(--rare-blue-light-200)', color: 'var(--rare-blue-light-700)' },
        dark: { backgroundColor: 'var(--rare-blue-light-950)', borderColor: 'var(--rare-blue-light-800)', color: 'var(--rare-blue-light-200)' },
    },
    blue: {
        light: { backgroundColor: 'var(--rare-blue-50)', borderColor: 'var(--rare-blue-200)', color: 'var(--rare-blue-700)' },
        dark: { backgroundColor: 'var(--rare-blue-950)', borderColor: 'var(--rare-blue-800)', color: 'var(--rare-blue-200)' },
    },
    indigo: {
        light: { backgroundColor: 'var(--rare-indigo-50)', borderColor: 'var(--rare-indigo-200)', color: 'var(--rare-indigo-700)' },
        dark: { backgroundColor: 'var(--rare-indigo-950)', borderColor: 'var(--rare-indigo-800)', color: 'var(--rare-indigo-200)' },
    },
    purple: {
        light: { backgroundColor: 'var(--rare-purple-50)', borderColor: 'var(--rare-purple-200)', color: 'var(--rare-purple-700)' },
        dark: { backgroundColor: 'var(--rare-purple-950)', borderColor: 'var(--rare-purple-800)', color: 'var(--rare-purple-200)' },
    },
    pink: {
        light: { backgroundColor: 'var(--rare-pink-50)', borderColor: 'var(--rare-pink-200)', color: 'var(--rare-pink-700)' },
        dark: { backgroundColor: 'var(--rare-pink-950)', borderColor: 'var(--rare-pink-800)', color: 'var(--rare-pink-200)' },
    },
    orange: {
        light: { backgroundColor: 'var(--rare-orange-50)', borderColor: 'var(--rare-orange-200)', color: 'var(--rare-orange-700)' },
        dark: { backgroundColor: 'var(--rare-orange-950)', borderColor: 'var(--rare-orange-800)', color: 'var(--rare-orange-200)' },
    },
};

function useTheme(): 'light' | 'dark' {
    const [theme, setTheme] = React.useState<'light' | 'dark'>('light');
    React.useEffect(() => {
        const root = document.documentElement;
        const observer = new MutationObserver(() => {
            setTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
        });
        setTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
        observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
    }, []);
    return theme;
}

export const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(({
    asChild = false,
    variant = 'pill',
    size = 'md',
    color = 'gray',
    dot: dotProp,
    pulse = false,
    icon,
    trailingIcon,
    onIconClick,
    onTrailingIconClick,
    onDismiss,
    className,
    children,
    style,
    ...props
}, ref) => {
    // Dot is only allowed on the `modern` variant — ignore dot prop for pill/badge
    const dot = variant === 'modern' ? (dotProp ?? true) : false;
    const Comp = asChild ? Slot : 'div';
    const theme = useTheme();

    const variantClasses = {
        pill: 'rounded-full border border-transparent',
        badge: 'rounded-sm border border-transparent',
        modern: 'rounded-sm bg-background-secondary border border-secondary text-foreground-secondary shadow-xs',
    };

    const colorStyle = variant !== 'modern' ? colorStyles[color]?.[theme] : undefined;

    return (
        <Comp
            ref={ref}
            className={cn(
                'inline-flex items-center justify-center whitespace-nowrap font-sans font-medium transition-all duration-200 no-underline',
                sizeClasses[size],
                variantClasses[variant],
                pulse && 'animate-badge-pulse motion-reduce:animate-none',
                className
            )}
            style={{ ...colorStyle, ...style }}
            {...props}
        >
            {dot && (
                <span
                    className={cn(
                        'size-1.5 rounded-full',
                        variant === 'modern' ? dotColorClass[color] : 'bg-current'
                    )}
                    aria-hidden="true"
                />
            )}
            {icon && (onIconClick ? (
                <button type="button" onClick={(e) => { e.stopPropagation(); onIconClick(); }} className="flex items-center bg-transparent border-none p-0 cursor-pointer text-current focus-visible:outline-none focus-visible:shadow-focus-ring-brand focus-visible:rounded-full">{icon}</button>
            ) : (
                <span className="flex items-center" aria-hidden="true">{icon}</span>
            ))}
            {children}
            {trailingIcon && (onTrailingIconClick ? (
                <button type="button" onClick={(e) => { e.stopPropagation(); onTrailingIconClick(); }} className="flex items-center bg-transparent border-none p-0 cursor-pointer text-current focus-visible:outline-none focus-visible:shadow-focus-ring-brand focus-visible:rounded-full">{trailingIcon}</button>
            ) : (
                <span className="flex items-center" aria-hidden="true">{trailingIcon}</span>
            ))}
            {onDismiss && (
                <button
                    type="button"
                    className="flex items-center justify-center bg-transparent border-none cursor-pointer p-xxs ml-xxs rounded-full text-current opacity-70 hover:opacity-100 hover:bg-background-hover transition-opacity duration-200 focus-visible:outline-none focus-visible:shadow-focus-ring-brand focus-visible:rounded-full"
                    onClick={(e) => {
                        e.stopPropagation();
                        onDismiss();
                    }}
                    aria-label="Dismiss"
                >
                    <X size={size === 'sm' ? 12 : 14} />
                </button>
            )}
        </Comp>
    );
});

Badge.displayName = 'Badge';
