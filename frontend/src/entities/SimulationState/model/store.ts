import { create } from 'zustand';

export type SpeedMultiplier = '2X' | '3X' | '5X' | '10X' | '20X';

interface SimulationState {
    // Weather Settings
    temperature: string;
    setTemperature: (temp: string) => void;
    // Time Options
    timeHours: string;
    timeMinutes: string;
    setTime: (hours: string, minutes: string) => void;

    // Game Speed
    speed: SpeedMultiplier;
    setSpeed: (speed: SpeedMultiplier) => void;

    // Emergency Situations
    equipmentFailure: boolean;
    setEquipmentFailure: (status: boolean) => void;

    windDirChange: boolean;
    windDirectionDegree: string;
    setWindDirChange: (status: boolean) => void;
    setWindDirectionDegree: (degree: string) => void;

    fireAreaIncrease: boolean;
    setFireAreaIncrease: (status: boolean) => void;
}

export const useSimulationStore = create<SimulationState>((set) => ({
    temperature: '',
    setTemperature: (temp) => set({ temperature: temp }),

    timeHours: '',
    timeMinutes: '',
    setTime: (hours, minutes) => set({ timeHours: hours, timeMinutes: minutes }),

    speed: '3X', // Default selected in mockup
    setSpeed: (speed) => set({ speed }),

    equipmentFailure: true,
    setEquipmentFailure: (status) => set({ equipmentFailure: status }),

    windDirChange: true,
    windDirectionDegree: '',
    setWindDirChange: (status) => set({ windDirChange: status }),
    setWindDirectionDegree: (degree) => set({ windDirectionDegree: degree }),

    fireAreaIncrease: true,
    setFireAreaIncrease: (status) => set({ fireAreaIncrease: status }),
}));
