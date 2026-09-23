"use client";

import { useEffect } from "react";
import { BRAND } from "@/lib/brand";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          <h1 className="font-heading text-base font-semibold">
            {BRAND.name} hit a snag
          </h1>
          <p className="text-sm text-muted-foreground">
            Something went wrong while loading this view. This is usually
            temporary — retrying often clears it.
          </p>
          <Button
            className="mt-1"
            onClick={() => reset()}
            variant="destructive"
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
