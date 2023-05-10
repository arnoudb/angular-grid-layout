import { Component, Inject, OnDestroy, OnInit, ViewChild, ViewEncapsulation } from '@angular/core';
import {
    KtdDragEnter,
    KtdDrop,
    KtdGridComponent,
    KtdGridLayout,
    KtdGridLayoutItem,
    ktdTrackById
} from '@katoid/angular-grid-layout';
import { fromEvent, merge, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { DOCUMENT } from '@angular/common';
import { coerceNumberProperty } from '@angular/cdk/coercion';

function generateLayout2(cols: number, size: number) {
    const rows = cols;
    const layout: any[] = [];
    let counter = 0;
    for (let i = 0; i < rows; i += size) {
        for (let j = i; j < cols; j += size) {
            layout.push({
                id: `${counter + 20}`,
                x: j,
                y: i,
                w: size,
                h: size
            });
            counter++;
        }
    }

    return layout;
}

@Component({
    selector: 'ktd-scroll-test',
    templateUrl: './scroll-test.component.html',
    styleUrls: ['./scroll-test.component.scss'],
})
export class KtdScrollTestComponent implements OnInit, OnDestroy {
    @ViewChild('grid1', {static: true, read: KtdGridComponent}) grid1: KtdGridComponent;
    @ViewChild('grid2', {static: true, read: KtdGridComponent}) grid2: KtdGridComponent;

    trackById = ktdTrackById;
    cols = 12;
    rowHeight = 50;
    compactType: 'vertical' | 'horizontal' | null = 'vertical';
    scrollSpeed = 10;
    layout1: KtdGridLayout = [
        {id: '0', x: 0, y: 0, w: 3, h: 3},
        {id: '1', x: 3, y: 0, w: 3, h: 3},
        {id: '2', x: 6, y: 0, w: 3, h: 3},
        {id: '3', x: 9, y: 0, w: 3, h: 3},
        {id: '4', x: 3, y: 3, w: 3, h: 3},
        {id: '5', x: 6, y: 3, w: 3, h: 3},
        {id: '6', x: 9, y: 3, w: 3, h: 3},
        {id: '7', x: 9, y: 6, w: 3, h: 3},
        {id: '8', x: 9, y: 9, w: 3, h: 3},
        {id: '9', x: 9, y: 12, w: 3, h: 3},
        {id: '10', x: 3, y: 15, w: 3, h: 3},
        {id: '11', x: 3, y: 18, w: 3, h: 3}
    ];

    cols2 = 36;
    layout2: KtdGridLayout = generateLayout2(this.cols2, 3);

    private resizeSubscription: Subscription;

    constructor(@Inject(DOCUMENT) public document) { }

    ngOnInit() {
        this.resizeSubscription = merge(
            fromEvent(window, 'resize'),
            fromEvent(window, 'orientationchange')
        ).pipe(
            debounceTime(50)
        ).subscribe(() => {
            this.grid1.resize();
            this.grid2.resize();
        });
    }

    ngOnDestroy() {
        this.resizeSubscription.unsubscribe();
    }

    onScrollSpeedChange(event: Event) {
        this.scrollSpeed = coerceNumberProperty((event.target as HTMLInputElement).value);
    }

    newItem:KtdGridLayoutItem;
    dragStart(event: DragEvent) {
        //$event.dataTransfer.setData()
        console.log('dragStart', event)
        this.newItem = {id: Math.random() + '', x: 3, y: 18, w: 3, h: 3};
        event.dataTransfer?.setData("text/plain", this.newItem.id);
    }

    dragEnter(event: DragEvent) {
        event.preventDefault();
        console.log('dragEnter', event);
    }

    drop(event: DragEvent) {
        event.preventDefault();
        console.log('drop', event);
        this.layout1 = [this.newItem, ...this.layout1];
    }

    dragOver(event: DragEvent) {
        event.preventDefault();
        console.log('dragOver');
    }

    // todo we want to handle this in the grid
    // this is more for visual feedback etc
    onKtdDragEnterGrid1(event: KtdDragEnter) {
        console.log('KtdDragEnter grid 1');
        if (! this.layout1.find(e => e.id === event.layoutItem.id)) {
            //this.layout1 = [...this.layout1, {...event.layoutItem}];
            console.log('item NOT added to grid1 layout, hack, we should handle this inside the grid!')
        }
    }

    // todo we want to handle this in the grid
    // this is more for visual feedback etc
    onKtdDragEnterGrid2(event: KtdDragEnter) {
        console.log('KtdDragEnter grid 2');
        if (! this.layout2.find(e => e.id === event.layoutItem.id)) {
            //this.layout2 = [...this.layout2, {...event.layoutItem}];
            console.log('item added to grid2 layout, hack, we should handle this inside the grid!')
        }
    }

    onKtdDrop1(event: KtdDrop) {
        console.log('KtdDrop here we should add it not earlier....');
        this.layout2 = this.layout2.filter(item => item.id !== event.layoutItem?.id);
        this.layout1 = event.newTargetLayout ?? this.layout1;
        console.log('item removed from origin !');
    }

    onKtdDrop2(event: KtdDrop) {
        console.log('KtdDrop here we should add it not earlier....');
        this.layout1 = this.layout1.filter(item => item.id !== event.layoutItem?.id);
        this.layout2 = [...this.layout2, {...event.layoutItem}];
        console.log('item removed from origin !');
    }
}
