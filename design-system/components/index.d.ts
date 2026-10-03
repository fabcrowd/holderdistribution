import type * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'accent';
}
export declare function Button(props: ButtonProps): React.ReactElement;

export interface BadgeProps {
  tone?: 'neutral' | 'positive' | 'negative';
  children?: React.ReactNode;
}
export declare function Badge(props: BadgeProps): React.ReactElement;

export interface StatCardProps {
  label: string;
  value: string;
  change?: string;
  trend?: 'positive' | 'negative' | 'flat';
}
export declare function StatCard(props: StatCardProps): React.ReactElement;

declare global {
  interface Window {
    HolderAnalytics: {
      Button: typeof Button;
      Badge: typeof Badge;
      StatCard: typeof StatCard;
    };
  }
}
