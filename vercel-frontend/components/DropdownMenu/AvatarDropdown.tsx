import * as React from 'react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarImage, AvatarFallback, AvatarStatus } from '../Avatar/Avatar';
import { AvatarLabelGroup } from '../Avatar/AvatarLabelGroup';
import type { AvatarStatusType } from '../Avatar/Avatar';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
} from './DropdownMenu';

export interface AvatarDropdownProps {
    src?: string;
    /** Two-letter fallback initials. */
    fallback?: string;
    name: string;
    /** Secondary text in header (email, role, etc.). */
    email?: string;
    status?: AvatarStatusType;
    children: React.ReactNode;
    /** @default 'end' */
    align?: 'start' | 'center' | 'end';
    /** @default 'bottom' */
    side?: 'top' | 'right' | 'bottom' | 'left';
    /** @default 4 */
    sideOffset?: number;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    disabled?: boolean;
    className?: string;
    contentClassName?: string;
}

export const AvatarDropdown = React.forwardRef<HTMLButtonElement, AvatarDropdownProps>(
    ({
        src,
        fallback,
        name,
        email,
        status,
        children,
        align = 'end',
        side = 'bottom',
        sideOffset = 4,
        open: controlledOpen,
        onOpenChange,
        disabled,
        className,
        contentClassName,
    }, ref) => {
        const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
        const isControlled = controlledOpen !== undefined;
        const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

        const handleOpenChange = (nextOpen: boolean) => {
            if (!isControlled) setUncontrolledOpen(nextOpen);
            onOpenChange?.(nextOpen);
        };

        return (
            <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
                <DropdownMenuTrigger asChild disabled={disabled}>
                    <button
                        ref={ref}
                        type="button"
                        className={cn(
                            'rounded-full focus-visible:outline-none cursor-pointer',
                            'focus-visible:shadow-focus-ring-brand',
                            'disabled:opacity-50 disabled:pointer-events-none',
                            isOpen && 'shadow-focus-ring-gray',
                            className
                        )}
                        aria-label={`Open user menu for ${name}`}
                    >
                        <Avatar size="md">
                            <AvatarImage src={src} alt={name} />
                            <AvatarFallback>{fallback}</AvatarFallback>
                            {status && <AvatarStatus status={status} />}
                        </Avatar>
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    open={isOpen}
                    align={align}
                    side={side}
                    sideOffset={sideOffset}
                    className={cn('p-0', contentClassName)}
                >
                    {/* User header */}
                    <div className="px-2xl py-xl border-b border-secondary">
                        <AvatarLabelGroup
                            src={src}
                            fallback={fallback}
                            name={name}
                            email={email}
                            status={status}
                            size="md"
                        />
                    </div>
                    {/* Menu items */}
                    <div className="pt-xs">
                        {children}
                    </div>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    },
);

AvatarDropdown.displayName = 'AvatarDropdown';
