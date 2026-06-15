import { Link } from "wouter";
import { Button } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <h1 className="text-9xl font-extrabold text-primary/20">404</h1>
      <h2 className="text-2xl font-bold mt-4 mb-2">Trang không tồn tại</h2>
      <p className="text-muted-foreground mb-8 max-w-md">
        Xin lỗi, trang bạn đang tìm kiếm không tồn tại hoặc đã bị di chuyển.
      </p>
      <Link href="/">
        <Button size="lg">Quay về Trang chủ</Button>
      </Link>
    </div>
  );
}
