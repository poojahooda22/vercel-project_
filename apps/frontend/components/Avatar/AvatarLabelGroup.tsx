import * as React from "react"
import { Avatar, AvatarImage, AvatarFallback, AvatarStatus } from "../Avatar/Avatar"
import type { AvatarSize, AvatarStatusType } from "../Avatar/Avatar"
import { cn } from "@/lib/utils"

export interface AvatarLabelGroupProps {
    src?: string;
    /** Two-letter initials for fallback. */
    fallback?: string;
    name: string;
    /** Secondary line — typically email or role. */
    email?: string;
    /** @default 'md' */
    size?: Extract<AvatarSize, 'sm' | 'md' | 'lg' | 'xl'>;
    status?: AvatarStatusType;
    className?: string;
}

const sizeConfig: Record<string, { gap: string; nameClass: string; emailClass: string }> = {
    sm: { gap: 'gap-lg', nameClass: 'text-sm', emailClass: 'text-xs' },
    md: { gap: 'gap-xl', nameClass: 'text-sm', emailClass: 'text-sm' },
    lg: { gap: 'gap-xl', nameClass: 'text-base', emailClass: 'text-base' },
    xl: { gap: 'gap-2xl', nameClass: 'text-lg', emailClass: 'text-base' },
};

export const AvatarLabelGroup = React.forwardRef<HTMLDivElement, AvatarLabelGroupProps>(
    ({ src, fallback, name, email, size = 'md', status, className }, ref) => {
        const config = sizeConfig[size] || sizeConfig.md;

        return (
            <div ref={ref} className={cn('flex items-center', config.gap, className)}>
                <Avatar size={size} className="shrink-0">
                    <AvatarImage src={src} alt={name} />
                    <AvatarFallback>{fallback}</AvatarFallback>
                    {status && <AvatarStatus status={status} />}
                </Avatar>

                <div className="flex flex-col items-start min-w-0 overflow-hidden">
                    <span className={cn('max-w-full font-semibold text-foreground-secondary truncate', config.nameClass)}>
                        {name}
                    </span>
                    {email && (
                        <span className={cn('max-w-full font-normal text-foreground-tertiary truncate', config.emailClass)}>
                            {email}
                        </span>
                    )}
                </div>
            </div>
        );
    },
);

AvatarLabelGroup.displayName = 'AvatarLabelGroup';
