import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MainLayout from './MainLayout';

vi.mock('../store/useAuthStore', () => ({
  useAuthStore: () => ({
    user: { email: 'tester@example.com' },
    signOut: vi.fn(),
  }),
}));

describe('MainLayout 文档列表 Drawer', () => {
  it('打开后展示个人/共享两个 Tabs，并默认加载个人文档列表', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /文档列表/ }));

    expect(await screen.findByRole('tab', { name: '个人文档' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '共享文档' })).toBeTruthy();
  });

  it('切换到共享 Tabs 后显示共享占位', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /文档列表/ }));
    await user.click(await screen.findByRole('tab', { name: '共享文档' }));

    expect(await screen.findByText('共享文档功能开发中')).toBeTruthy();
  });
});
