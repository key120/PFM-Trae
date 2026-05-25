import React from 'react';
import { Progress } from 'antd';
import './CardProgressBar.css';

interface CardProgressBarProps {
  percent: number;
  message: string;
  visible: boolean;
}

const CardProgressBar: React.FC<CardProgressBarProps> = ({
  percent,
  message,
  visible,
}) => {
  return (
    <div className={`card-progress-bar ${visible ? 'visible' : ''}`}>
      <div className="card-progress-info">
        <span className="card-progress-message">{message}</span>
        <span className="card-progress-percent">{percent}%</span>
      </div>
      <Progress percent={percent} showInfo={false} strokeColor="#1677ff" />
    </div>
  );
};

export default CardProgressBar;
