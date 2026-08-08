import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonHierarchy = "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** @default 'primary' */
  hierarchy?: ButtonHierarchy;
  leadingIcon?: ReactNode;
}

export function Button({
  hierarchy = "primary",
  leadingIcon,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={[styles.button, styles[hierarchy], className].filter(Boolean).join(" ")}
      {...rest}
    >
      {leadingIcon ? <span className={styles.icon}>{leadingIcon}</span> : null}
      {children}
    </button>
  );
}
