import React from 'react';
import { cn } from '../lib/utils';

export interface PixelCheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
    label?: string;
}

export const PixelCheckbox = React.forwardRef<HTMLInputElement, PixelCheckboxProps>(
    ({ className, label, ...props }, ref) => {
        return (
            <label className={cn("flex items-center gap-2 cursor-pointer select-none", className)}>
                <div className="relative flex items-center justify-center">
                    <input
                        type="checkbox"
                        ref={ref}
                        className="peer appearance-none w-4 h-4 bg-[#404040] border-2 border-black outline-none checked:bg-[#404040] transition-all"
                        {...props}
                    />
                    {/* Custom Checkmark (only visible when checked via peer-checked) */}
                    <svg
                        className="absolute w-3 h-3 text-white pointer-events-none hidden peer-checked:block"
                        viewBox="0 0 14 14"
                        fill="none"
                    >
                        <path
                            d="M3 7L6 10L11 3"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="square"
                            strokeLinejoin="miter"
                            vectorEffect="non-scaling-stroke"
                        />
                    </svg>
                </div>
                {label && <span className="text-[10px] uppercase text-white leading-none mt-[2px]">{label}</span>}
            </label>
        );
    }
);
PixelCheckbox.displayName = 'PixelCheckbox';
