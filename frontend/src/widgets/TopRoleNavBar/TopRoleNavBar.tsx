import React from 'react';
import { PixelButton } from '../../shared/ui/PixelButton';

interface TopRoleNavBarProps {
    roles: string[];
    activeRole: string;
    setActiveRole: (role: string) => void;
}

export const TopRoleNavBar: React.FC<TopRoleNavBarProps> = ({ roles, activeRole, setActiveRole }) => {
    return (
        <div className="w-full h-[50px] bg-mchs-gray flex items-center px-4 shrink-0 border-b-2 border-black z-20">
            {/* Logo */}
            <div className="text-white text-[16px] tracking-wide font-pixel mr-8 whitespace-nowrap drop-shadow-[2px_2px_0_rgba(0,0,0,0.8)]">
                МЧС ТРЕНАЖЕР
            </div>

            {/* Role Tabs */}
            <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar flex-1 h-full py-2">
                {roles.map((role) => (
                    <PixelButton
                        key={role}
                        variant={activeRole === role ? 'active' : 'default'}
                        onClick={() => setActiveRole(role)}
                        className="flex-1 min-w-[120px] max-w-[200px]"
                    >
                        {role}
                    </PixelButton>
                ))}
            </div>
        </div>
    );
};
