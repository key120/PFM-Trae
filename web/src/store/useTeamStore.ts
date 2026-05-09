import { create } from 'zustand';
import type { TeamRole } from '../services/teamService';

export interface TeamSummary {
  id: string;
  name: string;
}

interface TeamState {
  teams: TeamSummary[];
  currentTeamId: string | null;
  currentUserRole: TeamRole | null;
  setTeams: (teams: TeamSummary[]) => void;
  addTeam: (team: TeamSummary) => void;
  setCurrentTeamId: (teamId: string | null) => void;
  setCurrentUserRole: (role: TeamRole | null) => void;
  reset: () => void;
}

export const useTeamStore = create<TeamState>((set) => ({
  teams: [],
  currentTeamId: null,
  currentUserRole: null,
  setTeams: (teams) =>
    set((state) => {
      const nextCurrentTeamId =
        state.currentTeamId && teams.some((team) => team.id === state.currentTeamId)
          ? state.currentTeamId
          : teams[0]?.id ?? null;

      return {
        teams,
        currentTeamId: nextCurrentTeamId,
        currentUserRole: nextCurrentTeamId ? state.currentUserRole : null,
      };
    }),
  addTeam: (team) =>
    set((state) => ({
      teams: [...state.teams, team],
      currentTeamId: state.currentTeamId ?? team.id,
    })),
  setCurrentTeamId: (teamId) => set({ currentTeamId: teamId, currentUserRole: null }),
  setCurrentUserRole: (role) => set({ currentUserRole: role }),
  reset: () => set({ teams: [], currentTeamId: null, currentUserRole: null }),
}));
