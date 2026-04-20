import { create } from 'zustand';

export interface TeamSummary {
  id: string;
  name: string;
}

interface TeamState {
  teams: TeamSummary[];
  currentTeamId: string | null;
  setTeams: (teams: TeamSummary[]) => void;
  addTeam: (team: TeamSummary) => void;
  setCurrentTeamId: (teamId: string | null) => void;
  reset: () => void;
}

export const useTeamStore = create<TeamState>((set) => ({
  teams: [],
  currentTeamId: null,
  setTeams: (teams) =>
    set((state) => ({
      teams,
      currentTeamId:
        state.currentTeamId && teams.some((team) => team.id === state.currentTeamId)
          ? state.currentTeamId
          : teams[0]?.id ?? null,
    })),
  addTeam: (team) =>
    set((state) => ({
      teams: [...state.teams, team],
      currentTeamId: state.currentTeamId ?? team.id,
    })),
  setCurrentTeamId: (teamId) => set({ currentTeamId: teamId }),
  reset: () => set({ teams: [], currentTeamId: null }),
}));
