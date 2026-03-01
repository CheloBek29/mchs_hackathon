import React from 'react';
import { PixelButton } from './PixelButton';
import { cn } from '../lib/utils';

interface PixelModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: React.ReactNode;
    className?: string;
}

export const PixelModal: React.FC<PixelModalProps> = ({ isOpen, onClose, title, children, className }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            {/* Modal Container */}
            <div className={cn(
                "bg-[#2b2b2b] w-full max-w-sm border-4 border-black font-pixel shadow-[8px_8px_0_rgba(0,0,0,0.5)] flex flex-col",
                className
            )}>

                {/* Header */}
                <div className="flex items-center justify-between bg-[#1a1a1a] p-2 border-b-4 border-black">
                    <h3 className="text-white text-[10px] tracking-wide m-0 pl-1">{title}</h3>
                    <PixelButton onClick={onClose} variant="default" className="text-[10px] px-2 py-1 leading-none shadow-none h-auto">
                        X
                    </PixelButton>
                </div>

                {/* Content */}
                <div className="p-4 text-white">
                    {children}
                </div>

            </div>
        </div>
    );
};
