import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import CardProgressBar from './CardProgressBar';

describe('CardProgressBar', () => {
  it('visible 为 true 时显示进度条', () => {
    render(<CardProgressBar percent={50} message="下载中..." visible={true} />);

    expect(screen.getByText('下载中...')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('visible 为 false 时隐藏进度条', () => {
    const { container } = render(
      <CardProgressBar percent={0} message="准备中..." visible={false} />,
    );

    const progressBar = container.querySelector('.card-progress-bar');
    expect(progressBar?.classList.contains('visible')).toBe(false);
  });

  it('显示正确的阶段文案', () => {
    render(<CardProgressBar percent={75} message="解密中..." visible={true} />);

    expect(screen.getByText('解密中...')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
  });

  it('percent 为 0 时显示 0%', () => {
    render(<CardProgressBar percent={0} message="准备中..." visible={true} />);

    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('percent 为 100 时显示 100%', () => {
    render(<CardProgressBar percent={100} message="载入完成" visible={true} />);

    expect(screen.getByText('100%')).toBeTruthy();
  });
});
