import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function NotFound() {
  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          <h1 className="font-heading text-base font-semibold">
            Page not found
          </h1>
          <p className="text-sm text-muted-foreground">
            The page you were looking for doesn&apos;t exist in {BRAND.name}.
          </p>
          <Button asChild className="mt-1" variant="secondary">
            <Link href="/">Back to {BRAND.name}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
