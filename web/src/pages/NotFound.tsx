import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">Page not found.</p>
      <Button variant="outline" size="sm" render={<Link to="/" />}>
        ← Back to Activity
      </Button>
    </div>
  );
}
