import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"
import { Building2 } from "lucide-react"
import { cn } from "@/lib/utils"

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | '6xl';
export type AvatarStatusType = 'online' | 'company' | 'verified';

export interface AvatarProps extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> {
    size?: AvatarSize;
}

export interface AvatarStatusProps extends React.HTMLAttributes<HTMLSpanElement> {
    status: AvatarStatusType;
    /** Custom content for the company badge. Defaults to `Building2` icon. */
    companyIcon?: React.ReactNode;
}

const rootSizeClasses: Record<AvatarSize, string> = {
    xs:    'size-6 text-xs',
    sm:    'size-8 text-sm',
    md:    'size-10 text-base',
    lg:    'size-11 text-base',
    xl:    'size-12 text-lg',
    '2xl': 'size-14 text-xl',
    '3xl': 'size-16 text-2xl',
    '4xl': 'size-20 text-3xl',
    '5xl': 'size-24 text-4xl',
    '6xl': 'size-[120px] text-5xl',
};

/** Pixel-perfect from Figma */
const statusSizeMap: Record<AvatarSize, Record<AvatarStatusType, string>> = {
    xs:    { online: 'size-1.5',   company: 'size-2.5',    verified: 'size-2.5' },
    sm:    { online: 'size-2',     company: 'size-3',      verified: 'size-3' },
    md:    { online: 'size-2.5',   company: 'size-3.5',    verified: 'size-3.5' },
    lg:    { online: 'size-3',     company: 'size-3.5',    verified: 'size-3.5' },
    xl:    { online: 'size-3',     company: 'size-4',      verified: 'size-4' },
    '2xl': { online: 'size-3.5',   company: 'size-[18px]', verified: 'size-[18px]' },
    '3xl': { online: 'size-4',     company: 'size-5',      verified: 'size-5' },
    '4xl': { online: 'size-5',     company: 'size-6',      verified: 'size-6' },
    '5xl': { online: 'size-6',     company: 'size-[28px]', verified: 'size-[28px]' },
    '6xl': { online: 'size-7',     company: 'size-8',      verified: 'size-8' },
};

const AvatarContext = React.createContext<AvatarSize>('md');

const Avatar = React.forwardRef<React.ElementRef<typeof AvatarPrimitive.Root>, AvatarProps>(
    ({ className, size = 'md', ...props }, ref) => {
        return (
            <AvatarContext.Provider value={size}>
                <AvatarPrimitive.Root
                    ref={ref}
                    className={cn(
                        'relative inline-flex items-center justify-center align-middle',
                        'overflow-visible select-none rounded-full bg-background-secondary',
                        'focus-visible:outline-none focus-visible:shadow-focus-ring-brand',
                        rootSizeClasses[size],
                        className
                    )}
                    {...props}
                />
            </AvatarContext.Provider>
        )
    }
)
Avatar.displayName = AvatarPrimitive.Root.displayName

const AvatarImage = React.forwardRef<React.ElementRef<typeof AvatarPrimitive.Image>, React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>>(
    ({ className, ...props }, ref) => (
        <>
            {/* Contrast border (inner stroke) */}
            <div className="absolute inset-0 rounded-[inherit] border border-primary/[0.08] pointer-events-none z-[1]" />
            <AvatarPrimitive.Image
                ref={ref}
                className={cn('size-full object-cover rounded-[inherit] overflow-hidden', className)}
                {...props}
            />
        </>
    )
)
AvatarImage.displayName = AvatarPrimitive.Image.displayName

const AvatarFallback = React.forwardRef<React.ElementRef<typeof AvatarPrimitive.Fallback>, React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>>(
    ({ className, ...props }, ref) => (
        <AvatarPrimitive.Fallback
            ref={ref}
            className={cn(
                'size-full flex items-center justify-center rounded-full overflow-hidden',
                'bg-background-secondary text-foreground-secondary font-sans font-semibold',
                className
            )}
            {...props}
        />
    )
)
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName

const AvatarStatus = ({ status, companyIcon, className, ...props }: AvatarStatusProps) => {
    const size = React.useContext(AvatarContext);
    const sizeClass = statusSizeMap[size]?.[status] ?? 'size-2.5';

    return (
        <span
            className={cn(
                'absolute bottom-0 right-0 flex items-center justify-center rounded-full z-10 box-content',
                status === 'online' && 'bg-fg-success border-[1.5px] border-bg-primary',
                status === 'company' && 'bg-background-tertiary text-foreground-tertiary border-[1.5px] border-bg-primary -bottom-0.5 -right-0.5',
                status === 'verified' && 'bg-transparent border-none rounded-none overflow-visible p-0',
                sizeClass,
                className
            )}
            data-status={status}
            role="img"
            aria-label={`${status} status`}
            {...props}
        >
            {status === 'company' && (
                companyIcon ?? <Building2 style={{ width: '75%', height: '75%' }} strokeWidth={2} />
            )}
            {status === 'verified' && (
                <>
                    <span className="absolute top-1/2 left-1/2 w-[55%] h-[55%] -translate-x-1/2 -translate-y-1/2 bg-background rounded-full z-0" />
                    <svg className="relative z-[1]" width="100%" height="100%" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M15.4443 3.54203C15.6343 4.00142 15.9989 4.36658 16.458 4.55722L18.0679 5.22404C18.5273 5.41434 18.8923 5.77936 19.0826 6.23879C19.2729 6.69821 19.2729 7.21442 19.0826 7.67385L18.4163 9.28256C18.2259 9.74219 18.2256 10.2589 18.4169 10.7183L19.0821 12.3266C19.1764 12.5541 19.225 12.798 19.225 13.0443C19.225 13.2907 19.1765 13.5346 19.0823 13.7622C18.988 13.9898 18.8498 14.1965 18.6756 14.3707C18.5014 14.5448 18.2946 14.6829 18.067 14.7771L16.4583 15.4435C15.9989 15.6334 15.6337 15.9981 15.4431 16.4572L14.7763 18.067C14.586 18.5264 14.2209 18.8915 13.7615 19.0818C13.3021 19.2721 12.7859 19.2721 12.3265 19.0818L10.7178 18.4154C10.2583 18.2256 9.74229 18.226 9.28313 18.4165L7.67327 19.0824C7.2141 19.2722 6.69834 19.2721 6.23929 19.0819C5.78023 18.8918 5.41543 18.5272 5.22499 18.0682L4.55797 16.4579C4.36802 15.9985 4.00341 15.6334 3.5443 15.4427L1.93444 14.7759C1.47522 14.5857 1.11031 14.2209 0.919941 13.7617C0.729569 13.3026 0.729311 12.7866 0.919223 12.3272L1.58557 10.7185C1.7754 10.2591 1.77502 9.74308 1.58449 9.28392L0.919101 7.67291C0.824762 7.44536 0.776185 7.20145 0.776146 6.95512C0.776106 6.70879 0.824605 6.46487 0.918871 6.23729C1.01314 6.00971 1.15132 5.80294 1.32553 5.62878C1.49974 5.45463 1.70656 5.31651 1.93417 5.22232L3.54287 4.55597C4.00187 4.36618 4.3668 4.00204 4.55759 3.54346L5.22441 1.9336C5.41471 1.47417 5.77973 1.10916 6.23915 0.918855C6.69858 0.728554 7.21479 0.728554 7.67422 0.918855L9.28292 1.5852C9.74236 1.77504 10.2584 1.77465 10.7175 1.58412L12.3281 0.919888C12.7874 0.729694 13.3035 0.729733 13.7629 0.919996C14.2222 1.11026 14.5872 1.47517 14.7775 1.93448L15.4445 3.54482L15.4443 3.54203Z" fill="#2E90FA" />
                        <path fillRule="evenodd" clipRule="evenodd" d="M13.9166 7.37864C14.0502 7.16879 14.0949 6.91446 14.041 6.6716C13.9871 6.42874 13.8389 6.21724 13.6291 6.08364C13.4192 5.95004 13.1649 5.90527 12.922 5.95919C12.6792 6.0131 12.4677 6.16129 12.3341 6.37114L8.66283 12.1399L6.98283 10.0399C6.82751 9.84562 6.60138 9.72101 6.35418 9.69346C6.10699 9.66592 5.85897 9.7377 5.6647 9.89302C5.47043 10.0483 5.34582 10.2745 5.31827 10.5217C5.29073 10.7689 5.36251 11.0169 5.51783 11.2111L8.01783 14.3361C8.111 14.4528 8.23066 14.5454 8.36687 14.6065C8.50308 14.6675 8.65189 14.6951 8.80094 14.6871C8.94998 14.679 9.09494 14.6355 9.22376 14.5601C9.35258 14.4847 9.46154 14.3796 9.54158 14.2536L13.9166 7.37864Z" fill="white" />
                    </svg>
                </>
            )}
        </span>
    )
}

export { Avatar, AvatarImage, AvatarFallback, AvatarStatus }
